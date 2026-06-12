#!/usr/bin/env node
/*
 * update-data.js  —  rebuilds data.json for the WC2026 predictor.
 *
 * What it does, every run:
 *   1. reads baseline.json  (FIXED pre-tournament ratings — never changes)
 *   2. fetches FINISHED matches from a results API
 *   3. replays every match in date order, updating Elo from the baseline (idempotent)
 *   4. builds each team's last-5 W/D/L string (oldest -> newest)
 *   5. writes data.json   (the file the web page loads)
 *
 * Run live:   FOOTBALL_DATA_TOKEN=xxxx node update-data.js
 * Run a test: node update-data.js --mock      (reads mock-matches.json, no network)
 *
 * The page only consumes data.json, so you can swap the data source by rewriting
 * ONE function — fetchMatches() — as long as it returns the normalised shape:
 *   [{ date:ISOstring, home:"Name", away:"Name", hg:Number, ag:Number }]
 */

const fs = require("fs");

// ---- tuning ----
const K          = 36;   // Elo update size per match
const HOME_ADV   = 0;    // replay is venue-agnostic; the app adds home edge at predict time
const FORM_GAMES = 5;    // length of the form strip

// ---- name normalisation: API spelling -> our team names (extend as needed) ----
const ALIAS = {
  "United States":"USA", "USA":"USA",
  "Korea Republic":"South Korea", "South Korea":"South Korea", "Republic of Korea":"South Korea",
  "IR Iran":"Iran", "Iran":"Iran",
  "Turkey":"Türkiye", "Turkiye":"Türkiye", "Türkiye":"Türkiye",
  "Cote d'Ivoire":"Ivory Coast", "Côte d'Ivoire":"Ivory Coast", "Ivory Coast":"Ivory Coast",
  "Congo DR":"DR Congo", "DR Congo":"DR Congo", "Democratic Republic of the Congo":"DR Congo",
  "Cabo Verde":"Cape Verde", "Cape Verde":"Cape Verde",
  "Bosnia and Herzegovina":"Bosnia & Herzegovina", "Bosnia-Herzegovina":"Bosnia & Herzegovina",
  "Czech Republic":"Czechia", "Czechia":"Czechia",
  "Curacao":"Curaçao", "Curaçao":"Curaçao",
  "Saudi Arabia":"Saudi Arabia"
};
const norm = n => ALIAS[n] || n;

// ---- data source adapter: returns normalised finished matches ----
// Default: football-data.org v4 World Cup competition. Swap freely.
async function fetchMatches() {
  if (process.argv.includes("--mock")) {
    return JSON.parse(fs.readFileSync("mock-matches.json", "utf8"));
  }
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) throw new Error("Set FOOTBALL_DATA_TOKEN (or run with --mock).");

  // World Cup competition code is "WC". Add other competition codes / a friendlies
  // source here if your plan covers them, and concat the results.
  const url = "https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED";
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error("API " + res.status + " " + (await res.text()).slice(0, 200));
  const json = await res.json();

  return (json.matches || [])
    .filter(m => m.score && m.score.fullTime &&
                 m.score.fullTime.home != null && m.score.fullTime.away != null)
    .map(m => ({
      date: m.utcDate,
      home: norm(m.homeTeam && m.homeTeam.name),
      away: norm(m.awayTeam && m.awayTeam.name),
      hg:   m.score.fullTime.home,
      ag:   m.score.fullTime.away
    }));
}

// ---- Elo replay (idempotent: always starts from the frozen baseline) ----
function expected(rh, ra) { return 1 / (1 + Math.pow(10, -((rh + HOME_ADV) - ra) / 400)); }
// goal-difference weight (World Football Elo style): draw/1-goal = 1, then scales up
function movMult(margin) {
  const a = Math.abs(margin);
  if (a <= 1) return 1;
  if (a === 2) return 1.5;
  return (11 + a) / 8;
}

function replay(baseline, matches) {
  const R = { ...baseline };                       // working copy
  const sorted = [...matches].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const m of sorted) {
    // Elo only updates when BOTH sides are rated teams (i.e. in our 48)
    if (R[m.home] == null || R[m.away] == null) continue;
    const Eh = expected(R[m.home], R[m.away]);
    const Sh = m.hg > m.ag ? 1 : m.hg < m.ag ? 0 : 0.5;
    const delta = K * movMult(m.hg - m.ag) * (Sh - Eh);
    R[m.home] += delta;
    R[m.away] -= delta;
  }
  for (const k in R) R[k] = Math.round(R[k]);
  return R;
}

// ---- form strips: start from frozen pre-tournament strip, append new results, keep last 5 ----
function buildForm(teamNames, baseForm, matches) {
  const byTeam = {};
  teamNames.forEach(n => (byTeam[n] = (baseForm[n] || "").toUpperCase().replace(/[^WDL]/g, "").split("")));
  const sorted = [...matches].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const m of sorted) {
    if (byTeam[m.home]) byTeam[m.home].push(m.hg > m.ag ? "W" : m.hg < m.ag ? "L" : "D");
    if (byTeam[m.away]) byTeam[m.away].push(m.ag > m.hg ? "W" : m.ag < m.hg ? "L" : "D");
  }
  const out = {};
  for (const n of teamNames) out[n] = byTeam[n].slice(-FORM_GAMES).join("");  // oldest -> newest
  return out;
}

(async () => {
  const baseFile = JSON.parse(fs.readFileSync("baseline.json", "utf8"));
  const baseline = baseFile.ratings;
  const teamNames = Object.keys(baseline);

  let matches = [];
  try {
    matches = await fetchMatches();
  } catch (e) {
    console.error("Fetch failed:", e.message, "\nWriting data.json from baseline only (no results).");
  }

  const ratings = replay(baseline, matches);
  const freshForm = buildForm(teamNames, baseFile.form || {}, matches);

  const out = { updated: new Date().toISOString(),
                source: process.argv.includes("--mock") ? "mock" : "football-data.org WC",
                matches: matches.length, teams: {} };
  for (const n of teamNames) {
    out.teams[n] = { e: ratings[n], form: freshForm[n] || "" };
  }

  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log(`data.json written — ${teamNames.length} teams, ${matches.length} finished matches replayed.`);
})();
