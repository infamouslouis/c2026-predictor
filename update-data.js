#!/usr/bin/env node
/*
 * update-data.js  —  rebuilds data.json for the WC2026 predictor.
 *
 * Each run:
 *   1. reads baseline.json  (FIXED pre-tournament ratings + form — never changes)
 *   2. fetches FINISHED matches from a results API
 *   3. replays them in date order. For EACH match it FIRST predicts the result using the
 *      ratings/form as they stood *just before kickoff* (so the track record is honest —
 *      no peeking at the result), records prediction vs actual, THEN applies the result.
 *   4. writes data.json: updated ratings, last-5 form, and a public "track" record.
 *
 * Run live:   FOOTBALL_DATA_TOKEN=xxxx node update-data.js
 * Run a test: node update-data.js --mock      (reads mock-matches.json, no network)
 *
 * Swap the data source by rewriting ONE function — fetchMatches() — to return:
 *   [{ date:ISOstring, home:"Name", away:"Name", hg:Number, ag:Number }]
 */

const fs = require("fs");

// ===== Elo replay tuning =====
const K        = 36;   // Elo update size per match
const HOME_ELO = 0;    // replay is venue-agnostic; home edge is applied at predict time only
const FORM_GAMES = 5;

// ===== prediction model (MUST mirror the constants in index.html) =====
const ELO_SCALE = 200, G_BASE = 1.35, ATT_K = 0.50, DEF_K = 0.56, G_CAP = 4.30;
const RHO = -0.12, MAXG = 8, FORM_MAX = 55, HV = 70;
const HOSTS = new Set(["USA", "Canada", "Mexico"]);
const STYLE = {            // keep in sync with index.html
  "Germany":45,"Norway":45,"Portugal":35,"Spain":30,"Brazil":25,"Netherlands":25,"Colombia":25,
  "Austria":25,"France":20,"Belgium":20,
  "Iran":-50,"Morocco":-45,"Tunisia":-35,"Uruguay":-30,"Saudi Arabia":-30,"Croatia":-25,
  "Switzerland":-25,"Egypt":-25,"Paraguay":-25,"Japan":-20,"Jordan":-20,"Algeria":-15,
  "USA":-15,"South Korea":-15,"Senegal":-15,"Mexico":-10
};

// ---- name normalisation: API spelling -> our team names (extend as needed) ----
const ALIAS = {
  "United States":"USA","USA":"USA",
  "Korea Republic":"South Korea","South Korea":"South Korea","Republic of Korea":"South Korea",
  "IR Iran":"Iran","Iran":"Iran",
  "Turkey":"Türkiye","Turkiye":"Türkiye","Türkiye":"Türkiye",
  "Cote d'Ivoire":"Ivory Coast","Côte d'Ivoire":"Ivory Coast","Ivory Coast":"Ivory Coast",
  "Congo DR":"DR Congo","DR Congo":"DR Congo","Democratic Republic of the Congo":"DR Congo",
  "Cabo Verde":"Cape Verde","Cape Verde":"Cape Verde",
  "Bosnia and Herzegovina":"Bosnia & Herzegovina","Bosnia-Herzegovina":"Bosnia & Herzegovina",
  "Czech Republic":"Czechia","Czechia":"Czechia",
  "Curacao":"Curaçao","Curaçao":"Curaçao","Saudi Arabia":"Saudi Arabia"
};
const norm = n => ALIAS[n] || n;

// ---- data source: returns normalised finished matches ----
async function fetchMatches() {
  if (process.argv.includes("--mock")) return JSON.parse(fs.readFileSync("mock-matches.json", "utf8"));
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) throw new Error("Set FOOTBALL_DATA_TOKEN (or run with --mock).");
  const url = "https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED";
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error("API " + res.status + " " + (await res.text()).slice(0, 200));
  const json = await res.json();
  return (json.matches || [])
    .filter(m => m.score && m.score.fullTime && m.score.fullTime.home != null && m.score.fullTime.away != null)
    .map(m => ({ date: m.utcDate, home: norm(m.homeTeam && m.homeTeam.name), away: norm(m.awayTeam && m.awayTeam.name),
                 hg: m.score.fullTime.home, ag: m.score.fullTime.away }));
}

// ===== maths =====
const fact = n => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);
const tau  = (x, y, a, b) => x===0&&y===0 ? 1-a*b*RHO : x===0&&y===1 ? 1+a*RHO : x===1&&y===0 ? 1+b*RHO : x===1&&y===1 ? 1-RHO : 1;
function formAdj(arr) {
  const s = arr.slice(-FORM_GAMES);
  if (!s.length) return 0;
  let num = 0, den = 0;
  for (let i = 0; i < s.length; i++) { const w = i+1, v = s[i]==="W"?1:s[i]==="L"?-1:0; num += v*w; den += w; }
  return Math.round((num/den) * (s.length/5) * FORM_MAX);
}
function clamp(x){ return Math.min(Math.max(x, 0.22), G_CAP); }

// predict one match from CURRENT ratings (R) + CURRENT form arrays (F), home team first
function predict(R, F, home, away, ELOAVG) {
  const eH = R[home], eA = R[away];
  if (eH == null || eA == null) return null;
  const skH = STYLE[home]||0, skA = STYLE[away]||0;
  const fH = formAdj(F[home]||[]), fA = formAdj(F[away]||[]);
  const bH = HOSTS.has(home) ? HV : 0, bA = HOSTS.has(away) ? HV : 0;
  const aH = eH+skH+fH+bH, dH = eH-skH+fH+bH, aA = eA+skA+fA+bA, dA = eA-skA+fA+bA;
  const lH = clamp(G_BASE * Math.exp(ATT_K*(aH-ELOAVG)/ELO_SCALE) * Math.exp(-DEF_K*(dA-ELOAVG)/ELO_SCALE));
  const lA = clamp(G_BASE * Math.exp(ATT_K*(aA-ELOAVG)/ELO_SCALE) * Math.exp(-DEF_K*(dH-ELOAVG)/ELO_SCALE));
  let pH=0,pD=0,pA=0, pk={p:-1,i:0,j:0}, tot=0, g=[];
  for (let i=0;i<=MAXG;i++){ g[i]=[]; for (let j=0;j<=MAXG;j++){ const p=Math.max(tau(i,j,lH,lA),0)*pois(i,lH)*pois(j,lA); g[i][j]=p; tot+=p; } }
  for (let i=0;i<=MAXG;i++) for (let j=0;j<=MAXG;j++){ const p=g[i][j]/tot; if(p>pk.p)pk={p,i,j}; if(i>j)pH+=p; else if(i<j)pA+=p; else pD+=p; }
  const pick = pH>=pD&&pH>=pA ? "home" : pA>=pD&&pA>=pH ? "away" : "draw";
  return { pH, pD, pA, pick, topH: pk.i, topA: pk.j };
}

// ===== Elo update =====
const expd = (rh, ra) => 1/(1+Math.pow(10, -((rh+HOME_ELO)-ra)/400));
const mov  = m => { const a=Math.abs(m); return a<=1?1:a===2?1.5:(11+a)/8; };

(async () => {
  const baseFile = JSON.parse(fs.readFileSync("baseline.json", "utf8"));
  const baseline = baseFile.ratings;
  const teamNames = Object.keys(baseline);
  const ELOAVG = teamNames.reduce((s,n)=>s+baseline[n],0)/teamNames.length;

  let matches = [];
  try { matches = await fetchMatches(); }
  catch (e) { console.error("Fetch failed:", e.message, "\nWriting data.json from baseline only."); }
  matches.sort((a,b)=> new Date(a.date) - new Date(b.date));

  const R = { ...baseline };
  const F = {}; teamNames.forEach(n => F[n] = (baseFile.form[n]||"").toUpperCase().replace(/[^WDL]/g,"").split(""));

  const log = [];
  let outcomeHits = 0, scoreHits = 0, brier = 0, scored = 0;

  for (const m of matches) {
    if (R[m.home] == null || R[m.away] == null) continue;
    const pr = predict(R, F, m.home, m.away, ELOAVG);
    const actual = m.hg > m.ag ? "home" : m.hg < m.ag ? "away" : "draw";
    const oHit = pr.pick === actual;
    const sHit = pr.topH === m.hg && pr.topA === m.ag;
    if (oHit) outcomeHits++;
    if (sHit) scoreHits++;
    brier += Math.pow(pr.pH-(actual==="home"?1:0), 2) + Math.pow(pr.pD-(actual==="draw"?1:0), 2) + Math.pow(pr.pA-(actual==="away"?1:0), 2);
    scored++;
    log.push({ date:m.date, home:m.home, away:m.away, hg:m.hg, ag:m.ag,
               pick:pr.pick, pH:+pr.pH.toFixed(3), pD:+pr.pD.toFixed(3), pA:+pr.pA.toFixed(3),
               topH:pr.topH, topA:pr.topA, oHit, sHit });
    const Eh = expd(R[m.home], R[m.away]);
    const Sh = m.hg>m.ag ? 1 : m.hg<m.ag ? 0 : 0.5;
    const d = K * mov(m.hg-m.ag) * (Sh - Eh);
    R[m.home] += d; R[m.away] -= d;
    F[m.home].push(m.hg>m.ag?"W":m.hg<m.ag?"L":"D");
    F[m.away].push(m.ag>m.hg?"W":m.ag<m.hg?"L":"D");
  }
  for (const k in R) R[k] = Math.round(R[k]);

  const out = {
    updated: new Date().toISOString(),
    source: process.argv.includes("--mock") ? "mock" : "football-data.org WC",
    matches: matches.length,
    teams: {},
    track: { played: scored, outcomeHits, scoreHits, brier: scored ? +(brier/scored).toFixed(3) : null, matches: log }
  };
  for (const n of teamNames) out.teams[n] = { e: R[n], form: F[n].slice(-FORM_GAMES).join("") };

  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("data.json written - " + teamNames.length + " teams, " + matches.length + " matches. " +
              "Track: result " + outcomeHits + "/" + scored + ", exact score " + scoreHits + "/" + scored +
              (scored ? ", Brier " + (brier/scored).toFixed(3) + "." : "."));
})();
