import { useEffect, useMemo, useState } from "react";

/* ---------- persistence ---------- */
const LS_KEY = "wp-tracker-state-v7a";
const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; } };
const save = (state) => localStorage.setItem(LS_KEY, JSON.stringify(state));

/* ---------- helpers ---------- */
function parseClockMMSS(str) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec((str || "").trim());
  if (!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}
function fmtMMSS(s) {
  if (s == null || isNaN(s) || s < 0) s = 0;
  const m = Math.floor(s/60), r = s%60;
  return `${m}:${String(r).padStart(2,"0")}`;
}
function pct(numer, denom) {
  if (!denom) return "0.0%";
  return `${((numer/denom)*100).toFixed(1)}%`;
}
function nameStyleByExclusions(ex) {
  if (ex >= 2) return { color: '#b91c1c' };       // red on 2
  if (ex === 1) return { color: '#000000' };      // black on 1
  return { color: '#18453B' };                    // MSU green on 0
}
function rowStyleByExclusions(ex) {
  return ex >= 3 ? { color: '#b91c1c' } : undefined;  // full row red on 3+
}

const POS = { GK: "GK", FP: "FP" };
function normalizePos(val) {
  const s = String(val || "").trim().toLowerCase();
  if (["gk","goalkeeper","keeper","goalie"].includes(s)) return POS.GK;
  return POS.FP; // default everything else to Field Player
}

/* ---------- defaults ---------- */
const DEFAULT_ROSTER = [
  { id: crypto.randomUUID(), number: 1, name: "GK", pos: "GK" },
  { id: crypto.randomUUID(), number: 2, name: "A",  pos: "FP" },
  { id: crypto.randomUUID(), number: 3, name: "B",  pos: "FP" },
  { id: crypto.randomUUID(), number: 4, name: "C",  pos: "FP" },
  { id: crypto.randomUUID(), number: 5, name: "D",  pos: "FP" },
  { id: crypto.randomUUID(), number: 6, name: "E",  pos: "FP" },
  { id: crypto.randomUUID(), number: 7, name: "F",  pos: "FP" },
  { id: crypto.randomUUID(), number: 8, name: "G",  pos: "FP" },
];

const GOALIE_ACTIONS = [
  { key: "save",           label: "Save" },
  { key: "goal_against",   label: "Goal Against" },
  { key: "penalty_block",  label: "Penalty Block" },
  { key: "assist",         label: "Assist" },
  { key: "steal",          label: "Steal" },
  { key: "turnover",       label: "Turnover" },
  { key: "exclusion",      label: "Exclusion" },
  { key: "forced_exclusion", label: "Forced Excl" },
];

const FIELD_ACTIONS = [
  { key: "goal",           label: "Goal" },
  { key: "attempt",        label: "Attempt" },
  { key: "assist",         label: "Assist" },
  { key: "steal",          label: "Steal" },
  { key: "turnover",       label: "Turnover" },
  { key: "exclusion",      label: "Exclusion" },
  { key: "forced_exclusion", label: "Forced Excl" },
  { key: "block",          label: "Block" },
];

export default function App() {
  const restored = load();

  /* ---------- game meta + setup ---------- */
  const [opponent, setOpponent]   = useState(restored?.opponent ?? "");
  const [period, setPeriod]       = useState(restored?.period ?? 1);
  const [periodLenSec, setPeriodLenSec] = useState(restored?.periodLenSec ?? 8*60);
  const [gameStarted, setGameStarted] = useState(restored?.gameStarted ?? false);
  const [gameEnded, setGameEnded] = useState(restored?.gameEnded ?? false);


  /* CSV import mode: true = merge/update, false = replace */
  const [importAppend, setImportAppend] = useState(true);

  /* ---------- runtime ---------- */
  const [timeouts, setTimeouts] = useState(
    restored?.timeouts ?? { msu: { short: 1, full: 2 }, opp: { short: 1, full: 2 } }
  );
  const [timeoutLog, setTimeoutLog] = useState(restored?.timeoutLog ?? []);
  const [clock, setClock]         = useState(restored?.clock ?? fmtMMSS(periodLenSec));
  const [roster, setRoster]       = useState(restored?.roster ?? DEFAULT_ROSTER);
  const [log, setLog]             = useState(restored?.log ?? []);
  const [activeIds, setActiveIds] = useState(restored?.activeIds ?? []);
  const [timePlayed, setTimePlayed] = useState(restored?.timePlayed ?? {}); // id -> seconds
  const [swimWins, setSwimWins]     = useState(restored?.swimWins ?? {});   // id -> count
  const [swimLosses, setSwimLosses] = useState(restored?.swimLosses ?? {}); // id -> count
  const [lastEventSec, setLastEventSec] = useState(restored?.lastEventSec ?? periodLenSec);
  const [betweenPeriods, setBetweenPeriods] = useState(restored?.betweenPeriods ?? false);
  const [clockEdit, setClockEdit] = useState(false);
  // Swim-off for current period (player + winner), winner set any time during period
  const [swimOffForPeriod, setSwimOffForPeriod] = useState(
    restored?.swimOffForPeriod ?? { period: null, playerId: null, winner: null }
  );

  // Swim-off warning banner (kept but we hard-block starts anyway)
  const [showSwimWarn, setShowSwimWarn] = useState(false);

  /* ---------- substitution (multi-select OUT/IN at time) ---------- */
  const [subMode, setSubMode] = useState(false);
  const [subTimeSec, setSubTimeSec] = useState(null);
  const [selectedOut, setSelectedOut] = useState(new Set());
  const [selectedIn, setSelectedIn] = useState(new Set());
  const [notes, setNotes] = useState(restored?.notes ?? "");
  /* ---------- Start Game setup UI state ---------- */
  const [setupStarters, setSetupStarters] = useState(new Set(restored?.setupStarters ?? []));
  const [setupSwimOffId, setSetupSwimOffId] = useState(restored?.setupSwimOffId ?? null);
  const [setupMinutes, setSetupMinutes] = useState(restored?.periodLenSec ? Math.round(restored.periodLenSec/60) : 8);

  // Team stats (offense/defense) + in-progress flags
  const [teamStats, setTeamStats] = useState(restored?.teamStats ?? {
    manUp:       { attempts: 0, goals: 0, stops: 0 },          // Offense 6v5
    manDown:     { defenses: 0, stops: 0, goalsAgainst: 0 },   // Defense 5v6
    penFor:      { attempts: 0, goals: 0, misses: 0 },         // Our penalties taken
    penAgainst:  { attempts: 0, saves: 0, goalsAgainst: 0 },   // Opponent penalties vs us
  });
  const [situations, setSituations] = useState(restored?.situations ?? {
    manUp: false,
    manDown: false,
  });
  // === EDIT MODE ===
  const [editMode, setEditMode] = useState(false);

  // For manual event creation
  const [manualEvent, setManualEvent] = useState({
    playerId: roster[0]?.id ?? null,
    type: "assist",
    clockMMSS: "",
    periodOverride: ""
  });

  // Unified event type list (covers GK + Field + special)
  const EVENT_TYPES = [
    // Field
    { key: "goal", label: "Goal" },
    { key: "attempt", label: "Attempt" },
    { key: "assist", label: "Assist" },
    { key: "steal", label: "Steal" },
    { key: "turnover", label: "Turnover" },
    { key: "exclusion", label: "Exclusion" },
    { key: "forced_exclusion", label: "Forced Excl" },
    { key: "block", label: "Block" },
    // GK-specific + special
    { key: "save", label: "Save (GK)" },
    { key: "goal_against", label: "Goal Against (GK)" },
    { key: "penalty_block", label: "Penalty Block (GK)" },
  ];

  useEffect(() => {
    const handleClick = (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      btn.classList.add("flash-success");
      setTimeout(() => btn.classList.remove("flash-success"), 500);
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);
  function adjustClock(deltaSec) {
    setClock(prev => {
      const parsed = parseClockMMSS(prev);
      const base = parsed != null ? parsed : (typeof lastEventSec === 'number' ? lastEventSec : periodLenSec);
      const clamped = Math.max(0, Math.min(periodLenSec, base + deltaSec));
      setLastEventSec(clamped);
      return fmtMMSS(clamped);
    });
  }

  function adjustTeamStat(section, key, delta) {
    setTeamStats(t => {
      const cur = (t[section]?.[key] ?? 0) + delta;
      return {
        ...t,
        [section]: {
          ...t[section],
          [key]: Math.max(0, cur) // don't go below 0
        }
      };
    });
  }
  // CRUD helpers on the log
  function removeEvent(eventId){
    setLog(prev => prev.filter(e => e.id !== eventId));
  }

  function updateEvent(eventId, patch){
    setLog(prev => prev.map(e => e.id === eventId ? { ...e, ...patch } : e));
  }

  // Use/adjust helpers
  function useTimeout(team /* 'msu' | 'opp' */, type /* 'short' | 'full' */) {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    setTimeouts(t => {
      const cur = t[team][type];
      if (cur <= 0) { alert(`${team === 'msu' ? 'MSU' : 'Opponent'} has no ${type==='short'?'30s':'Full'} timeouts left.`); return t; }
      return { ...t, [team]: { ...t[team], [type]: cur - 1 } };
    });
    setTimeoutLog(prev => [
      ...prev,
      { id: crypto.randomUUID(), ts: Date.now(), period, clock, team, type }
    ]);
  }

  function adjustTimeout(team, type, delta) {
    setTimeouts(t => ({
      ...t,
      [team]: { ...t[team], [type]: Math.max(0, (t[team][type] ?? 0) + delta) }
    }));
  }
  function addManualEvent() {
    const pid = manualEvent.playerId;
    const type = manualEvent.type;
    if (!pid || !type) return;

    // Time/period overrides are optional
    const sec = manualEvent.clockMMSS ? parseClockMMSS(manualEvent.clockMMSS) : null;
    const periodVal = manualEvent.periodOverride ? Number(manualEvent.periodOverride) : period;
    const clockStr = sec != null ? fmtMMSS(sec) : clock;

    setLog(prev => [
      ...prev,
      {
        id: crypto.randomUUID(),
        ts: Date.now(),
        period: periodVal,
        clock: clockStr,
        playerId: pid,
        type
      }
    ]);

    setManualEvent(m => ({ ...m, clockMMSS: "" })); // clear time input
  }

  /* ---------- persistence ---------- */
  useEffect(() => {
    save({
      opponent, period, periodLenSec, gameStarted, gameEnded,
      clock, roster, log, activeIds, timePlayed,
      swimWins, swimLosses, lastEventSec, betweenPeriods,
      swimOffForPeriod,
      setupStarters: [...setupStarters],
      setupSwimOffId,
      teamStats,
      situations,
      timeouts,   
      timeoutLog,
      savedAt: Date.now()
    });
  }, [opponent, period, periodLenSec, gameStarted, gameEnded, clock, roster, log, activeIds, timePlayed,
      swimWins, swimLosses, lastEventSec, betweenPeriods, swimOffForPeriod,
      setupStarters, setupSwimOffId, teamStats, situations, notes, timeouts, timeoutLog]);

  /* ---------- CSV import (merge/replace) ---------- */
  function importRosterCSV(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) { alert("CSV is empty."); return; }

        // header optional: number,name,pos
        let startIdx = 0;
        const first = lines[0].toLowerCase();
        if (first.includes("number") || first.includes("name")) startIdx = 1;

        const incoming = [];
        for (let i = startIdx; i < lines.length; i++) {
          const parts = lines[i].split(",").map(c => c.trim());
          if (!parts.length) continue;

          const number = parseInt(parts[0], 10);
          const name   = parts[1] ?? "";
          const posRaw = parts[2] ?? "FP";
          if (Number.isNaN(number) || !name) continue;

          incoming.push({ number, name, pos: normalizePos(posRaw) });
        }
        if (!incoming.length) { alert("No valid players found in CSV."); return; }

        if (!importAppend) {
          // Replace mode
          const newRoster = incoming.map(r => ({
            id: crypto.randomUUID(),
            number: r.number,
            name: r.name,
            pos: r.pos,
          }));
          setRoster(newRoster);
        } else {
          // Merge/append mode (match by jersey number)
          setRoster(prev => {
            const byNumber = new Map(prev.map(p => [p.number, p]));
            incoming.forEach(r => {
              const existing = byNumber.get(r.number);
              if (existing) {
                existing.name = r.name || existing.name;
                existing.pos  = r.pos  || existing.pos;
              } else {
                byNumber.set(r.number, {
                  id: crypto.randomUUID(),
                  number: r.number,
                  name: r.name,
                  pos: r.pos,
                });
              }
            });
            return Array.from(byNumber.values()).sort((a,b)=>a.number-b.number);
          });
        }

        // Clear starters/swim-off selections since ids might have changed
        setSetupStarters(new Set());
        setSetupSwimOffId(null);
        // Optionally: setActiveIds([]) to force re-pick if you import mid-game
      } catch (e) {
        console.error(e);
        alert("Could not parse CSV. Expect columns: number,name,pos");
      }
    };
    reader.readAsText(file);
  }

  /* ---------- event logging ---------- */
  function addEvent(playerId, type) {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    /* ---------- clock adjust helpers ---------- */
    function incrementClock(secDelta) {
      const s = parseClockMMSS(clock);
      if (s == null) return;
      const next = Math.max(0, Math.min(periodLenSec, s + secDelta));
      setClock(fmtMMSS(next));
      setLastEventSec(next);
    }

    // Extra metadata for certain events
    let extra = {};

    if (type === "goal_against") {
      const raw = window.prompt("Enter opposing player number (leave blank if unknown):", "");
      const cleaned = (raw ?? "").trim();
      if (cleaned) extra.oppScorer = cleaned;
    }

    setLog(prev => [
      ...prev,
      {
        id: crypto.randomUUID(),
        ts: Date.now(),
        period,
        clock,
        playerId,
        type,
        ...extra,
      },
    ]);
  }

  /* ---------- Start Game flow ---------- */
  function toggleStarter(id) {
    setSetupStarters(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function startGame() {
    const starters = roster.filter(p => setupStarters.has(p.id));
    if (starters.length !== 7) { alert("Select exactly 7 starters (1 GK + 6 field)."); return; }
    const gkCount = starters.filter(p => p.pos === "GK").length;
    if (gkCount !== 1) { alert("Starters must include exactly one GK."); return; }
    if (!setupSwimOffId) { alert("Select a swim-off player for Period 1 before starting."); return; }

    const mins = Number(setupMinutes);
    if (!mins || mins <= 0 || mins > 20) { alert("Enter a valid quarter length in minutes (e.g., 8)."); return; }
    if (setupSwimOffId && !setupStarters.has(setupSwimOffId)) {
      alert("Swim-off player must be one of the 7 starters.");
      return;
    }

    const lenSec = mins * 60;
    setPeriodLenSec(lenSec);
    setPeriod(1);
    setClock(fmtMMSS(lenSec));
    setLastEventSec(lenSec);
    setActiveIds(starters.map(p => p.id));
    setBetweenPeriods(false);
    setGameStarted(true);
    setGameEnded(false);
    setTeamStats({
      manUp: { attempts: 0, goals: 0, stops: 0 },
      manDown: { defenses: 0, stops: 0, goalsAgainst: 0 },
      penFor: { attempts: 0, goals: 0, misses: 0 },
      penAgainst: { attempts: 0, saves: 0, goalsAgainst: 0 },
    });
    setSituations({ manUp: false, manDown: false });
    setSwimOffForPeriod({ period: 1, playerId: setupSwimOffId || null, winner: null });
    setShowSwimWarn(false);
    setTimeouts({ msu: { short: 1, full: 2 }, opp: { short: 1, full: 2 } });
    setTimeoutLog([]);
  }

  /* ---------- swim-off winner buttons during period ---------- */
  function setSwimWinnerDuringPeriod(winner) {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    const cur = swimOffForPeriod;
    if (!cur || cur.period !== period || !cur.playerId) return;

    if (cur.winner && cur.winner !== winner) {
      if (cur.winner === 'msu') {
        setSwimWins(prev => ({ ...prev, [cur.playerId]: Math.max(0, (prev[cur.playerId] || 0) - 1) }));
      } else {
        setSwimLosses(prev => ({ ...prev, [cur.playerId]: Math.max(0, (prev[cur.playerId] || 0) - 1) }));
      }
    }
    if (winner === 'msu') {
      setSwimWins(prev => ({ ...prev, [cur.playerId]: (prev[cur.playerId] || 0) + (cur.winner==='msu'?0:1) }));
    } else {
      setSwimLosses(prev => ({ ...prev, [cur.playerId]: (prev[cur.playerId] || 0) + (cur.winner==='opponent'?0:1) }));
    }
    setSwimOffForPeriod({ ...cur, winner });
  }

  /* ---------- substitutions ---------- */
  function startSubstitution() {
    if (betweenPeriods || !gameStarted || gameEnded) { alert("Start the game/period before substituting."); return; }
    const input = window.prompt("Enter substitution clock time (MM:SS)", clock);
    const sec = parseClockMMSS(input || "");
    if (sec == null) { alert("Please enter time as MM:SS (e.g., 6:45)."); return; }
    if (sec > lastEventSec) { alert(`Time must go forward (down the clock). Last recorded: ${fmtMMSS(lastEventSec)}.`); return; }
    setSubMode(true); setSubTimeSec(sec);
    setSelectedOut(new Set()); setSelectedIn(new Set());
  }
  function toggleOut(id){ setSelectedOut(s=>{const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n;}); }
  function toggleIn(id){ setSelectedIn(s=>{const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n;}); }
  function applySubstitution(){
    if (selectedOut.size !== selectedIn.size){ alert("OUT count must equal IN count."); return; }
    const delta = lastEventSec - subTimeSec; if (delta < 0){ alert("Sub time must be <= last recorded time."); return; }

    const current = new Set(activeIds);
    const outIds = [...selectedOut], inIds = [...selectedIn];
    let tentative = new Set(current);
    outIds.forEach(id => tentative.delete(id));
    inIds.forEach(id => tentative.add(id));
    if (tentative.size > 7){ alert("Lineup would exceed 7 players."); return; }
    const getBy = (id)=> roster.find(p=>p.id===id);
    const gkCount = [...tentative].map(getBy).filter(p=>p?.pos==='GK').length;
    if (gkCount !== 1){ alert("Lineup must include exactly one GK."); return; }

    if (delta > 0){
      setTimePlayed(prev => {
        const next = { ...prev };
        activeIds.forEach(id => { next[id] = (next[id] || 0) + delta; });
        return next;
      });
    }

    setActiveIds([...tentative]);
    setLastEventSec(subTimeSec);
    setClock(fmtMMSS(subTimeSec));
    setSubMode(false);
  }
  function cancelSubstitution(){ setSubMode(false); setSelectedOut(new Set()); setSelectedIn(new Set()); setSubTimeSec(null); }
 
  /* -------- Man Up (Offense 6v5) -------- */
  function startManUp() {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    if (situations.manUp) return alert("Man Up already active.");
    setSituations(s => ({ ...s, manUp: true }));
    setTeamStats(t => ({ ...t, manUp: { ...t.manUp, attempts: t.manUp.attempts + 1 } }));
  }
  function endManUpScored() {
    if (!situations.manUp) return alert("No active Man Up.");
    setSituations(s => ({ ...s, manUp: false }));
    setTeamStats(t => ({ ...t, manUp: { ...t.manUp, goals: t.manUp.goals + 1 } }));
  }
  function endManUpStopped() {
    if (!situations.manUp) return alert("No active Man Up.");
    setSituations(s => ({ ...s, manUp: false }));
    setTeamStats(t => ({ ...t, manUp: { ...t.manUp, stops: t.manUp.stops + 1 } }));
  }

  /* -------- Penalty (For) -------- */
  function penForScored() {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    setTeamStats(t => ({ ...t, penFor: { ...t.penFor, attempts: t.penFor.attempts + 1, goals: t.penFor.goals + 1 } }));
  }
  function penForMissed() {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    setTeamStats(t => ({ ...t, penFor: { ...t.penFor, attempts: t.penFor.attempts + 1, misses: t.penFor.misses + 1 } }));
  }

  /* -------- Man Down (Defense 5v6) -------- */
  function startManDown() {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    if (situations.manDown) return alert("Man Down already active.");
    setSituations(s => ({ ...s, manDown: true }));
    setTeamStats(t => ({ ...t, manDown: { ...t.manDown, defenses: t.manDown.defenses + 1 } }));
  }
  function endManDownStopped() {
    if (!situations.manDown) return alert("No active Man Down.");
    setSituations(s => ({ ...s, manDown: false }));
    setTeamStats(t => ({ ...t, manDown: { ...t.manDown, stops: t.manDown.stops + 1 } }));
  }
  function endManDownGA() {
    if (!situations.manDown) return alert("No active Man Down.");
    setSituations(s => ({ ...s, manDown: false }));
    setTeamStats(t => ({ ...t, manDown: { ...t.manDown, goalsAgainst: t.manDown.goalsAgainst + 1 } }));
  }

  /* -------- Penalty (Against) -------- */
  function penAgainstSaved() {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    setTeamStats(t => ({ ...t, penAgainst: { ...t.penAgainst, attempts: t.penAgainst.attempts + 1, saves: t.penAgainst.saves + 1 } }));
  }
  function penAgainstGA() {
    if (betweenPeriods || !gameStarted || gameEnded) return;
    setTeamStats(t => ({ ...t, penAgainst: { ...t.penAgainst, attempts: t.penAgainst.attempts + 1, goalsAgainst: t.penAgainst.goalsAgainst + 1 } }));
  }

  /* ---------- end/start period ---------- */
  function endPeriod(){
    if (betweenPeriods || !gameStarted || gameEnded) return;
    const delta = lastEventSec - 0;
    if (delta > 0){
      setTimePlayed(prev => {
        const next = { ...prev };
        activeIds.forEach(id => { next[id] = (next[id] || 0) + delta; });
        return next;
      });
    }
    setBetweenPeriods(true);
    setActiveIds([]);
    setClock("0:00");
    setLastEventSec(0);
    setSubMode(false);
    setSwimOffForPeriod({ period: null, playerId: null, winner: null });
    setShowSwimWarn(false);
  }

  // Between-period starter + swim-off selection
  const [startSel, setStartSel] = useState(new Set());
  const [swimOffId, setSwimOffId] = useState(null);
  function toggleBetweenStarter(id){
    setStartSel(s=>{const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n;});
  }
  function applyStartPeriod(){
    if (startSel.size !== 7){ alert("Select exactly 7 starters (1 GK + 6 field)."); return; }
    const starters = roster.filter(p => startSel.has(p.id));
    const gkCount = starters.filter(p => p.pos === "GK").length;
    if (gkCount !== 1){ alert("Starters must include exactly one GK."); return; }
    if (swimOffId && !startSel.has(swimOffId)){ alert("Swim-off player must be one of the 7 starters."); return; }
    if (!swimOffId) { alert("Select a swim-off player for this period before starting."); return; }

    setPeriod(p => {
      const next = p + 1;
      setSwimOffForPeriod({ period: next, playerId: swimOffId || null, winner: null });
      return next;
    });
    setActiveIds(starters.map(p => p.id));
    setClock(fmtMMSS(periodLenSec));
    setLastEventSec(periodLenSec);
    setBetweenPeriods(false);
    setStartSel(new Set()); setSwimOffId(null);
  }

  /* ---------- End Game ---------- */
  function endGame() {
    if (!gameStarted || gameEnded) return;

    if (!betweenPeriods) {
      const delta = lastEventSec - 0;
      if (delta > 0) {
        setTimePlayed(prev => {
          const next = { ...prev };
          activeIds.forEach(id => { next[id] = (next[id] || 0) + delta; });
          return next;
        });
      }
    }
    setClock("0:00");
    setLastEventSec(0);
    setActiveIds([]);
    setSubMode(false);
    setBetweenPeriods(false);
    setSwimOffForPeriod({ period: null, playerId: null, winner: null });
    setShowSwimWarn(false);
    setGameEnded(true);
  }

  function newGame({ clearRoster = false } = {}) {
    if (!window.confirm("Start a new game? Current game data will be saved only in your CSV.")) return;
    const mins = Math.max(1, Math.round(periodLenSec / 60));
    const lenSec = mins * 60;
    if (clearRoster) setRoster(DEFAULT_ROSTER);

    setOpponent("");
    setPeriod(1);
    setPeriodLenSec(lenSec);
    setClock(fmtMMSS(lenSec));
    setLastEventSec(lenSec);

    setActiveIds([]);
    setLog([]);
    setTimePlayed({});
    setSwimWins({});
    setSwimLosses({});
    setSwimOffForPeriod({ period: null, playerId: null, winner: null });

    setTeamStats({
      manUp: { attempts: 0, goals: 0, stops: 0 },
      manDown: { defenses: 0, stops: 0, goalsAgainst: 0 },
      penFor: { attempts: 0, goals: 0, misses: 0 },
      penAgainst: { attempts: 0, saves: 0, goalsAgainst: 0 },
    });
    setSituations({ manUp: false, manDown: false });
    setSetupStarters(new Set());
    setSetupSwimOffId(null);
    setSetupMinutes(mins);

    setBetweenPeriods(false);
    setSubMode(false);
    setGameEnded(false);
    setGameStarted(false);
    setShowSwimWarn(false);
  }

  /* ---------- roster CRUD ---------- */
  function addPlayer(){
    const np = { id: crypto.randomUUID(), number: 0, name: "New", pos: "FP" };
    setRoster(r => [...r, np]);
  }
  function removePlayer(id){
    setRoster(r => r.filter(p => p.id !== id));
    setLog(l => l.filter(e => e.playerId !== id));
    setActiveIds(ids => ids.filter(x => x !== id));
    setTimePlayed(tp => { const n={...tp}; delete n[id]; return n; });
    setSwimWins(w => { const n={...w}; delete n[id]; return n; });
    setSwimLosses(l => { const n={...l}; delete n[id]; return n; });
    setSetupStarters(s => { const n=new Set(s); n.delete(id); return n; });
    if (setupSwimOffId === id) setSetupSwimOffId(null);
    if (swimOffForPeriod.playerId === id) setSwimOffForPeriod({ ...swimOffForPeriod, playerId: null, winner: null });
  }

  /* ---------- derived ---------- */
  const active = useMemo(() => roster.filter(p => activeIds.includes(p.id)), [roster, activeIds]);
  const bench  = useMemo(() => roster.filter(p => !activeIds.includes(p.id)), [roster, activeIds]);

  // Goals Against breakdown by opposing jersey number
  const gaByOpp = useMemo(() => {
    const map = {};
    log.forEach(e => {
      if (e.type === "goal_against" && e.oppScorer) {
        const key = `#${String(e.oppScorer).replace(/^#/, "")}`;
        map[key] = (map[key] || 0) + 1;
      }
    });
    return map;
  }, [log]);

  const gaOppKeys = useMemo(() => {
    return Object.keys(gaByOpp).sort((a, b) => {
      const na = parseInt(a.slice(1), 10);
      const nb = parseInt(b.slice(1), 10);
      if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
      return na - nb;
    });
  }, [gaByOpp]);

  const stats = useMemo(() => {
    const s = {};
    roster.forEach(p => {
      s[p.id] = {
        ...p,
        goals: 0, attempts: 0, shotPct: "0.0%", blocks: 0,
        saves: 0, goalsAgainst: 0, penaltyBlocks: 0, savePct: "0.0%",
        assists: 0, steals: 0, turnovers: 0, exclusions: 0, forcedExclusions: 0,
        timePlayedSec: timePlayed[p.id] || 0,
        swimWins: swimWins[p.id] || 0,
        swimLosses: swimLosses[p.id] || 0
      };
    });
    log.forEach(e => {
      const p = s[e.playerId]; if (!p) return;
      switch (e.type) {
        case "goal": p.goals++; p.attempts++; break;
        case "attempt": p.attempts++; break;
        case "block": p.blocks++; break;
        case "save": p.saves++; break;
        case "goal_against": p.goalsAgainst++; break;
        case "penalty_block": p.penaltyBlocks++; p.saves++; break;
        case "assist": p.assists++; break;
        case "steal": p.steals++; break;
        case "turnover": p.turnovers++; break;
        case "exclusion": p.exclusions++; break;
        case "forced_exclusion": p.forcedExclusions++; break;
        default: break;
      }
    });
    Object.values(s).forEach(p => {
      if (p.pos === "GK") {
        const faced = p.saves + p.goalsAgainst;
        p.savePct = pct(p.saves, faced);
      } else {
        p.shotPct = pct(p.goals, p.attempts);
      }
    });
    return Object.values(s);
  }, [roster, log, timePlayed, swimWins, swimLosses]);

  const goalies  = stats.filter(p => p.pos === "GK");
  const fielders = stats.filter(p => p.pos !== "GK");

  /* ---------- CSV ---------- */
  function downloadCSV(filename, rows) {
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }
  function exportPlayersCSV() {
    const header = "Number,Name,Pos,Active,TimePlayed,SwimWins,SwimLosses,Goals,Attempts,Shot%,Assists,Steals,Turnovers,Exclusions,ForcedExcl,Blocks,GoalsAgainst,Saves,Save%,PenaltyBlocks";
    const rows = [header];

    fielders.forEach(p => {
      const isActive = activeIds.includes(p.id) ? "Y" : "N";
      rows.push([
        p.number, p.name, p.pos, isActive,
        fmtMMSS(p.timePlayedSec),
        p.swimWins, p.swimLosses,
        p.goals, p.attempts, p.shotPct,
        p.assists, p.steals, p.turnovers, p.exclusions, p.forcedExclusions,
        p.blocks
      ].join(","));
    });


    const opp = (opponent || "opponent").replace(/[^a-z0-9]+/gi, "_");
    const date = new Date().toISOString().slice(0,10);
    downloadCSV(`wp_players_${date}_${opp}.csv`, rows);
  }

  function exportTeamCSV() {
    const rows = [];

    // Meta
    rows.push("Date,Opponent,PeriodLengthSec,CurrentPeriod,GameStarted,GameEnded");
    rows.push([
      new Date().toISOString().slice(0,10),
      `"${opponent.replace(/"/g,'""')}"`,
      periodLenSec,
      period,
      gameStarted ? "Y" : "N",
      gameEnded ? "Y" : "N"
    ].join(","));
    rows.push("");

    // Team Stats
    rows.push("Team Stats");
    rows.push("ManUp_Attempts,ManUp_Goals,ManUp_Stops,ManDown_Defenses,ManDown_Stops,ManDown_GA,PenFor_Attempts,PenFor_Goals,PenFor_Misses,PenAg_Attempts,PenAg_Saves,PenAg_GA");
    rows.push([
      teamStats.manUp.attempts, teamStats.manUp.goals, teamStats.manUp.stops,
      teamStats.manDown.defenses, teamStats.manDown.stops, teamStats.manDown.goalsAgainst,
      teamStats.penFor.attempts, teamStats.penFor.goals, teamStats.penFor.misses,
      teamStats.penAgainst.attempts, teamStats.penAgainst.saves, teamStats.penAgainst.goalsAgainst
    ].join(","));
    rows.push("");

    // Timeouts (if you added them)
    if (typeof timeouts !== "undefined") {
      rows.push("Timeouts");
      rows.push("Team,30s,Full");
      rows.push(["MSU", timeouts.msu.short, timeouts.msu.full].join(","));
      rows.push(["Opponent", timeouts.opp.short, timeouts.opp.full].join(","));
      rows.push("");
    }

    // Notes (optional)
    if (typeof notes !== "undefined" && notes) {
      rows.push("Notes");
      rows.push(`"${String(notes).replace(/"/g,'""')}"`);
      rows.push("");
    }

    const opp = (opponent || "opponent").replace(/[^a-z0-9]+/gi, "_");
    const date = new Date().toISOString().slice(0,10);
    downloadCSV(`wp_team_${date}_${opp}.csv`, rows);
  }
  function exportGoaliesCSV() {
    const header = "Number,Name,TimePlayed,GA,Saves,Save%,PK Blocks,Assists,Steals,Turnovers,Exclusions,ForcedExcl";
    const rows = [header];

    goalies.forEach(g => {
      rows.push([
        g.number,
        g.name,
        fmtMMSS(g.timePlayedSec),
        g.goalsAgainst,
        g.saves,
        g.savePct,
        g.penaltyBlocks,
        g.assists,
        g.steals,
        g.turnovers,
        g.exclusions,
        g.forcedExclusions
      ].join(","));
    });

    const opp = (opponent || "opponent").replace(/[^a-z0-9]+/gi, "_");
    const date = new Date().toISOString().slice(0,10);
    downloadCSV(`wp_goalies_${date}_${opp}.csv`, rows);
  }


  /* ---------- render ---------- */
  return (
    <div className="container">
      {/* Spartan banner */}
      <header style={{
        backgroundColor: '#18453B',
        color: 'white',
        padding: '20px',
        borderRadius: '14px',
        marginBottom: '24px',
        textAlign: 'center',
        boxShadow: '0 3px 12px rgba(0,0,0,0.2)',
        border: '2px solid #0f3027'
      }}>
        <h1 style={{
          margin: 0, fontSize: '1.9rem', letterSpacing: '0.8px',
          textTransform: 'uppercase', fontWeight: '700'
        }}>
          Michigan State Water Polo
        </h1>
        <p style={{ marginTop: '6px', fontSize: '1rem', opacity: 0.95, fontStyle: 'italic' }}>
          Spartan Green & White Edition
        </p>
      </header>

      {/* ---------- START GAME SETUP ---------- */}
      {!gameStarted && !gameEnded && (
        <div className="card teamstats" style={{marginBottom:12}}>
          <strong>Start Game</strong>
          <div className="row wrap" style={{marginTop:8, gap:12}}>
            <div style={{flex:'1 1 220px'}}>
              <label>Opponent</label>
              <input value={opponent} onChange={e=>setOpponent(e.target.value)} placeholder="Opponent name" />
            </div>
            <div>
              <label>Quarter Length (minutes)</label>
              <input type="number" style={{width:140}} value={setupMinutes}
                     onChange={e=>setSetupMinutes(e.target.value)} />
            </div>
          </div>

          {/* Roster editor */}
          <div className="card" style={{marginTop:12}}>
            <div className="row" style={{justifyContent:"space-between"}}>
              <strong>Roster</strong>
              <div className="row" style={{gap:8, alignItems:'center'}}>
                <label className="row" style={{gap:6}}>
                  <input
                    type="checkbox"
                    checked={importAppend}
                    onChange={e=>setImportAppend(e.target.checked)}
                  />
                  <span>Append/Update (keep existing)</span>
                </label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => importRosterCSV(e.target.files?.[0])}
                />
                <button onClick={addPlayer}>+ Add Player</button>
              </div>
            </div>
            <div className="grid" style={{marginTop:8}}>
              {roster.map(p=>(
                <div key={p.id} className="card">
                  <div className="row" style={{justifyContent:"space-between"}}>
                    <strong>#{p.number} {p.name}</strong>
                    <button onClick={()=>removePlayer(p.id)}>Remove</button>
                  </div>
                  <div className="row" style={{marginTop:8}}>
                    <input type="number" style={{width:90}} value={p.number}
                      onChange={e=>{
                        const v = Number(e.target.value);
                        setRoster(rs => rs.map(x => x.id===p.id ? {...x, number: v} : x));
                      }}/>
                    <input value={p.name}
                      onChange={e=>{
                        const v = e.target.value;
                        setRoster(rs => rs.map(x => x.id===p.id ? {...x, name: v} : x));
                      }}/>
                    <select
                      value={p.pos}
                      onChange={e=>{
                        const v = normalizePos(e.target.value);
                        setRoster(rs => rs.map(x => x.id===p.id ? {...x, pos: v} : x));
                      }}
                    >
                      <option value="GK">GK</option>
                      <option value="FP">FP</option>
                    </select>
                  </div>
                  <div className="row" style={{gap:8, marginTop:8}}>
                    <button
                      className={setupStarters.has(p.id) ? "primary" : ""}
                      onClick={()=>toggleStarter(p.id)}
                    >
                      {setupStarters.has(p.id) ? "Starter ✓" : "Mark Starter"}
                    </button>
                    <button
                      className="ghost"
                      onClick={()=>setSetupSwimOffId(prev => prev===p.id ? null : p.id)}
                      title="Swim-off player for Period 1"
                    >
                      {setupSwimOffId === p.id ? "Swim-off ✓" : "Set Swim-off"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="row" style={{gap:8, marginTop:12}}>
            <button className="primary" onClick={startGame}>Start Game</button>
          </div>
        </div>
      )}

      {/* ---------- FINAL / GAME ENDED VIEW ---------- */}
      {gameEnded && (
        <div className="card" style={{marginBottom:12}}>
          <strong>Game Final</strong>
          <p style={{opacity:.8, marginTop:6}}>All controls are closed. Review your stats below or export a CSV.</p>
          <div className="row" style={{gap:8, marginTop:8}}>
            <button className="primary" onClick={exportPlayersCSV}>Export Players CSV</button>
            <button onClick={exportGoaliesCSV}>Export Goalies CSV</button>
            <button onClick={exportTeamCSV}>Export Team CSV</button>
            <button onClick={()=>newGame()} title="Return to Start Game and keep roster">
              New Game
            </button>
          </div>
        </div>
      )}

      {/* ---------- LIVE GAME UI ---------- */}
      {gameStarted && !gameEnded && (
        <>
          {/* Game controls */}
          <div className="card" style={{marginBottom:12}}>
            <div className="row wrap">
              <div style={{flex:'1 1 220px'}}>
                <label>Opponent</label>
                <input value={opponent} onChange={e=>setOpponent(e.target.value)} placeholder="Opponent name" disabled={gameEnded} />
              </div>
              {/* Timeouts */}
              <div className="card" style={{ marginTop: 10, background:'#f8fafc' }}>
                <div className="row" style={{ justifyContent:'space-between', alignItems:'baseline' }}>
                  <strong>Timeouts</strong>
                  <span style={{opacity:.8}}>Track 1×30s + 2×Full per team</span>
                </div>

                <div className="row wrap" style={{ gap: 12, marginTop: 8 }}>
                  {/* MSU */}
                  <div className="card" style={{ padding:'8px 10px' }}>
                    <div className="row" style={{ justifyContent:'space-between' }}>
                      <b>MSU</b>
                      <span className="row" style={{ gap:8 }}>
                        <span className="badge">30s: {timeouts.msu.short}</span>
                        <span className="badge">Full: {timeouts.msu.full}</span>
                      </span>
                    </div>
                    <div className="row" style={{ gap:8, marginTop:8 }}>
                      <button
                        onClick={()=>useTimeout('msu','short')}
                        disabled={timeouts.msu.short<=0 || betweenPeriods || gameEnded}
                      >Use 30s</button>
                      <button
                        onClick={()=>useTimeout('msu','full')}
                        disabled={timeouts.msu.full<=0 || betweenPeriods || gameEnded}
                      >Use Full</button>

                      {editMode && (
                        <>
                          <button className="ghost" onClick={()=>adjustTimeout('msu','short',+1)}>+30s</button>
                          <button className="ghost" onClick={()=>adjustTimeout('msu','full',+1)}>+Full</button>
                          <button className="ghost" onClick={()=>adjustTimeout('msu','short',-1)}>-30s</button>
                          <button className="ghost" onClick={()=>adjustTimeout('msu','full',-1)}>-Full</button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Opponent */}
                  <div className="card" style={{ padding:'8px 10px' }}>
                    <div className="row" style={{ justifyContent:'space-between' }}>
                      <b>Opponent</b>
                      <span className="row" style={{ gap:8 }}>
                        <span className="badge">30s: {timeouts.opp.short}</span>
                        <span className="badge">Full: {timeouts.opp.full}</span>
                      </span>
                    </div>
                    <div className="row" style={{ gap:8, marginTop:8 }}>
                      <button
                        onClick={()=>useTimeout('opp','short')}
                        disabled={timeouts.opp.short<=0 || betweenPeriods || gameEnded}
                      >Use 30s</button>
                      <button
                        onClick={()=>useTimeout('opp','full')}
                        disabled={timeouts.opp.full<=0 || betweenPeriods || gameEnded}
                      >Use Full</button>

                      {editMode && (
                        <>
                          <button className="ghost" onClick={()=>adjustTimeout('opp','short',+1)}>+30s</button>
                          <button className="ghost" onClick={()=>adjustTimeout('opp','full',+1)}>+Full</button>
                          <button className="ghost" onClick={()=>adjustTimeout('opp','short',-1)}>-30s</button>
                          <button className="ghost" onClick={()=>adjustTimeout('opp','full',-1)}>-Full</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Optional: small history line */}
                {timeoutLog.length > 0 && (
                  <div style={{ marginTop: 10, opacity:.85 }}>
                    <div><b>Taken:</b></div>
                    <div className="row wrap" style={{ gap:8, marginTop:6 }}>
                      {[...timeoutLog].reverse().slice(0,8).map(t => (
                        <span key={t.id} className="badge">
                          {t.team==='msu'?'MSU':'OPP'} {t.type==='short'?'30s':'Full'} @ P{t.period} {t.clock}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label>Period</label>
                <input style={{width:100}} value={period} onChange={e=>setPeriod(Number(e.target.value)||1)} disabled={gameEnded} />
              </div>
              <div>
                <label>Clock (MM:SS)</label>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="mono"
                    style={{ width: 110 }}
                    value={clock}
                    readOnly={!clockEdit}
                    onChange={e => {
                      setClock(e.target.value);
                      const s = parseClockMMSS(e.target.value);
                      if (s != null && !betweenPeriods) setLastEventSec(s);
                    }}
                    onBlur={() => {
                      const s = parseClockMMSS(clock);
                      if (s != null) {
                        setClock(fmtMMSS(s));
                        setLastEventSec(s);
                      } else {
                        setClock(fmtMMSS(lastEventSec));
                      }
                      setClockEdit(false);
                    }}
                    disabled={betweenPeriods || gameEnded}
                  />
                  <button
                    className="ghost"
                    onClick={() => setClockEdit(v => !v)}
                    disabled={betweenPeriods || gameEnded}
                    title={clockEdit ? "Finish editing" : "Edit clock"}
                  >
                    {clockEdit ? "Done" : "Edit"}
                  </button>
                </div>

                {/* centered –10s / +10s under the clock */}
                <div
                  className="row clock-adjust"
                  style={{ marginTop: 6, gap: 8, justifyContent: "center" }}
                >
                  <button onClick={() => adjustClock(-10)} disabled={gameEnded}>–10s</button>
                  <button onClick={() => adjustClock(10)} disabled={gameEnded}>+10s</button>
                </div>
              </div>
              
              {/* Swim-off winner buttons visible all period if a swim-off player set */}
              {!betweenPeriods && swimOffForPeriod?.period === period && swimOffForPeriod?.playerId && (
                <div style={{display:'flex', flexDirection:'column', gap:6, marginTop:8}}>
                  <div style={{fontWeight:700}}>Period Swim-off Winner:</div>
                  <div className="row" style={{gap:8}}>
                    <button
                      className={swimOffForPeriod.winner === 'msu' ? 'primary' : ''}
                      onClick={()=>setSwimWinnerDuringPeriod('msu')}
                      disabled={gameEnded}
                    >MSU</button>
                    <button
                      className={swimOffForPeriod.winner === 'opponent' ? 'primary' : ''}
                      onClick={()=>setSwimWinnerDuringPeriod('opponent')}
                      disabled={gameEnded}
                    >Opponent</button>
                  </div>
                  <div style={{opacity:.8}}>
                    {swimOffForPeriod.winner
                      ? `Recorded: ${swimOffForPeriod.winner === 'msu' ? 'MSU' : 'Opponent'}`
                      : 'No result set yet'}
                  </div>
                </div>
              )}
              <button
                className={editMode ? "warn" : ""}
                onClick={() => setEditMode(v => !v)}
                title="Toggle editing panels and controls"
              >
                Edit Mode: {editMode ? "ON" : "OFF"}
              </button>
              <div className="row" style={{gap:8}}>
                {!betweenPeriods ? (
                  <>
                    <button onClick={startSubstitution} disabled={gameEnded}>Start Substitution</button>
                    <button onClick={endPeriod} disabled={gameEnded} title="Attribute remaining time then advance period">End Period</button>
                    <button className="primary" onClick={exportPlayersCSV}>Export Players CSV</button>
                    <button onClick={exportGoaliesCSV}>Export Goalies CSV</button>
                    <button onClick={exportTeamCSV}>Export Team CSV</button>
                    <button onClick={endGame} title="Close the game and lock controls" style={{borderColor:'#991b1b', color:'#991b1b'}}>End Game</button>
                  </>
                ) : (
                  <span style={{opacity:.8}}>Between periods — select starters below.</span>
                )}
              </div>
            </div>

            {/* (Optional banner; start is hard-blocked anyway) */}
            {!betweenPeriods && !gameEnded && showSwimWarn && (!swimOffForPeriod?.playerId) && (
              <div className="card" style={{marginTop:10, background:'#fff7ed', border:'1px solid #fbbf24'}}>
                <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
                  <div><strong>Warning:</strong> No swim-off player selected for this period.</div>
                  <button className="ghost" onClick={()=>setShowSwimWarn(false)}>Dismiss</button>
                </div>
              </div>
            )}
          </div>
          {/* 3️⃣ Quick Add Event form (only visible in edit mode) */}
          {editMode && (
            <div className="card" style={{ marginBottom: 12, borderColor: '#eab308' }}>
              <strong>Quick Add Event</strong>
              <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                <div>
                  <label>Player</label>
                  <select
                    value={manualEvent.playerId ?? ""}
                    onChange={e => setManualEvent(m => ({ ...m, playerId: e.target.value }))}
                  >
                    {roster.map(p => (
                      <option key={p.id} value={p.id}>
                        #{p.number} {p.name} {p.pos === 'GK' ? '• GK' : '• FP'}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label>Event</label>
                  <select
                    value={manualEvent.type}
                    onChange={e => setManualEvent(m => ({ ...m, type: e.target.value }))}
                  >
                    {EVENT_TYPES.map(t => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label>Quarter Time</label>
                  <input
                    className="mono"
                    placeholder={clock}
                    value={manualEvent.clockMMSS}
                    onChange={e => setManualEvent(m => ({ ...m, clockMMSS: e.target.value }))}
                    style={{ width: 110 }}
                  />
                </div>

                <div>
                  <label>Period</label>
                  <input
                    type="number"
                    style={{ width: 100 }}
                    placeholder={String(period)}
                    value={manualEvent.periodOverride}
                    onChange={e => setManualEvent(m => ({ ...m, periodOverride: e.target.value }))}
                  />
                </div>

                <div className="row" style={{ alignItems: 'end' }}>
                  <button className="primary" onClick={addManualEvent}>Add Event</button>
                </div>
              </div>
              <p style={{ opacity: .75, marginTop: 6 }}>
                Use this to manually add or correct events (assists, saves, goals, etc.).
              </p>
            </div>
          )}
          {/* Between periods: choose starters & swim-off for next period */}
          {betweenPeriods && (
            <div className="card" style={{marginBottom:12}}>
              <strong>Start Period {period + 1}</strong>
              <div style={{marginTop:6, opacity:.8}}>
                Select <b>exactly 7 starters</b> (must include 1 GK). Select a <b>Swim-off player</b>.
              </div>
              <div className="grid" style={{marginTop:10}}>
                {roster.map(p=>{
                  const selected = startSel.has(p.id);
                  const isSwim = swimOffId === p.id;
                  return (
                    <div key={p.id} className="card" style={{outline: selected ? '3px solid #22c55e' : undefined}}>
                      <div className="row" style={{justifyContent:'space-between'}}>
                        <strong>#{p.number} {p.name} {p.pos==='GK' ? '• GK' : '• FP'}</strong>
                        <div className="row" style={{gap:8}}>
                          <button onClick={()=>toggleBetweenStarter(p.id)}>{selected ? 'Starter ✓' : 'Mark Starter'}</button>
                          <button className="ghost" onClick={()=>setSwimOffId(prev => prev===p.id ? null : p.id)}>
                            {isSwim ? 'Swim-off ✓' : 'Set Swim-off'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="row" style={{gap:8, marginTop:10}}>
                <button className="primary" onClick={applyStartPeriod}>Start Period</button>
              </div>
            </div>
          )}

          {/* Layout: Active + Bench + Subs (3 columns) */}
          <div className="layout-two-col" style={{gap:12, gridTemplateColumns:'1fr 2fr 1fr'}}>
            {/* LEFT: Team Situations & Penalties */}
            <div className="card" style={{marginBottom:12}}>
              <strong>Team Stats — Situations</strong>

              {/* OFFENSE */}
              <div className="card" style={{marginTop:8}}>
                <div className="row" style={{justifyContent:'space-between', alignItems:'baseline'}}>
                  <span><b>Offense</b> — Man Up</span>
                  <span className="badge">{situations.manUp ? "ACTIVE" : "idle"}</span>
                </div>
                <div className="row" style={{gap:8, marginTop:8, flexWrap:'wrap'}}>
                  <button onClick={startManUp} disabled={situations.manUp || betweenPeriods || gameEnded}>Start Man Up</button>
                  <button onClick={endManUpScored} className={situations.manUp ? "primary" : ""} disabled={!situations.manUp || gameEnded}>End: Scored</button>
                  <button onClick={endManUpStopped} disabled={!situations.manUp || gameEnded}>End: Stopped</button>
                </div>
                <div style={{opacity:.85, marginTop:6}}>
                  Attempts: <b>{teamStats.manUp.attempts}</b> • Scored: <b>{teamStats.manUp.goals}</b> • Stopped: <b>{teamStats.manUp.stops}</b>
                </div>
              </div>

              <div className="card" style={{marginTop:8}}>
                <div><b>Offense</b> — Penalty Shots</div>
                <div className="row" style={{gap:8, marginTop:8, flexWrap:'wrap'}}>
                  <button onClick={penForScored} className="primary" disabled={betweenPeriods || gameEnded}>Scored</button>
                  <button onClick={penForMissed} disabled={betweenPeriods || gameEnded}>Missed</button>
                </div>
                <div style={{opacity:.85, marginTop:6}}>
                  Attempts: <b>{teamStats.penFor.attempts}</b> • Goals: <b>{teamStats.penFor.goals}</b> • Misses: <b>{teamStats.penFor.misses}</b>
                </div>
              </div>

              {/* DEFENSE */}
              <div className="card" style={{marginTop:8}}>
                <div className="row" style={{justifyContent:'space-between', alignItems:'baseline'}}>
                  <span><b>Defense</b> — Man Down</span>
                  <span className="badge">{situations.manDown ? "ACTIVE" : "idle"}</span>
                </div>
                <div className="row" style={{gap:8, marginTop:8, flexWrap:'wrap'}}>
                  <button onClick={startManDown} disabled={situations.manDown || betweenPeriods || gameEnded}>Start Man Down</button>
                  <button onClick={endManDownStopped} className={situations.manDown ? "primary" : ""} disabled={!situations.manDown || gameEnded}>End: Stopped</button>
                  <button onClick={endManDownGA} disabled={!situations.manDown || gameEnded}>End: Goal Against</button>
                </div>
                <div style={{opacity:.85, marginTop:6}}>
                  Defenses: <b>{teamStats.manDown.defenses}</b> • Stopped: <b>{teamStats.manDown.stops}</b> • GA: <b>{teamStats.manDown.goalsAgainst}</b>
                </div>
              </div>

              <div className="card" style={{marginTop:8}}>
                <div><b>Defense</b> — Penalty Shots</div>
                <div className="row" style={{gap:8, marginTop:8, flexWrap:'wrap'}}>
                  <button onClick={penAgainstSaved} className="primary" disabled={betweenPeriods || gameEnded}>Saved/Stopped</button>
                  <button onClick={penAgainstGA} disabled={betweenPeriods || gameEnded}>Goal Against</button>
                </div>
                <div style={{opacity:.85, marginTop:6}}>
                  Faced: <b>{teamStats.penAgainst.attempts}</b> • Saved: <b>{teamStats.penAgainst.saves}</b> • GA: <b>{teamStats.penAgainst.goalsAgainst}</b>
                </div>
              </div>
            </div>
            {/* MIDDLE: Active + Tables */}
            <div>
              <div className="card" style={{marginBottom:12}}>
                <div className="row" style={{justifyContent:"space-between", alignItems:"baseline"}}>
                  <strong>Active Lineup</strong>
                  <span className="badge">{active.length}/7</span>
                </div>

                {subMode && !betweenPeriods && (
                  <div className="card" style={{marginTop:8, background:'#f4f4f4'}}>
                    <strong>Substitution Mode</strong>
                    <div className="row" style={{marginTop:6, flexWrap:'wrap', gap:8}}>
                      <span>Sub Time: <span className="mono">{fmtMMSS(subTimeSec)}</span></span>
                      <span>Pick <b>OUT</b> from Active and <b>IN</b> from Bench, then Apply.</span>
                    </div>
                    <div className="row" style={{gap:8, marginTop:8}}>
                      <button className="primary" onClick={applySubstitution}>Apply Substitution</button>
                      <button className="ghost" onClick={cancelSubstitution}>Cancel</button>
                    </div>
                  </div>
                )}

                {/* ===== GK section ===== */}
                <div className="card" style={{marginTop:10}}>
                  <div className="row" style={{justifyContent:"space-between", alignItems:"baseline"}}>
                    <strong>Goalkeeper In Pool</strong>
                    <span className="badge">{active.filter(p => p.pos === "GK").length}/1</span>
                  </div>

                  <div className="grid" style={{marginTop:8}}>
                    {active.filter(p => p.pos === "GK").map(p => {
                      const outMarked = subMode && selectedOut.has(p.id);
                      return (
                        <div key={p.id} className="card" style={outMarked ? {outline:'3px solid #eab308'} : undefined}>
                          <div className="row" style={{justifyContent:"space-between"}}>
                            <strong>#{p.number} {p.name} • GK</strong>
                            {!betweenPeriods && subMode && (
                              <button onClick={()=>toggleOut(p.id)}>{outMarked ? "OUT ✓" : "Mark OUT"}</button>
                            )}
                          </div>
                          <div className="row wrap" style={{gap:8, marginTop:10}}>
                            {GOALIE_ACTIONS.map(a => (
                              <button
                                key={a.key}
                                className="ghost"
                                onClick={()=>addEvent(p.id, a.key)}
                                disabled={betweenPeriods || subMode || gameEnded}
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {active.filter(p => p.pos === "GK").length === 0 && (
                      <div className="card" style={{opacity:.7}}>No active goalkeeper.</div>
                    )}
                  </div>
                </div>

                {/* ===== Field Players section ===== */}
                <div className="card" style={{marginTop:10}}>
                  <div className="row" style={{justifyContent:"space-between", alignItems:"baseline"}}>
                    <strong>Field Players In Pool</strong>
                    <span className="badge">
                      {active.filter(p => p.pos !== "GK").length}/6
                    </span>
                  </div>

                  <div className="grid" style={{marginTop:8}}>
                    {active.filter(p => p.pos !== "GK").map(p => {
                      const outMarked = subMode && selectedOut.has(p.id);
                      return (
                        <div key={p.id} className="card" style={outMarked ? {outline:'3px solid #eab308'} : undefined}>
                          <div className="row" style={{justifyContent:"space-between"}}>
                            <strong>#{p.number} {p.name} • FP</strong>
                            {!betweenPeriods && subMode && (
                              <button onClick={()=>toggleOut(p.id)}>{outMarked ? "OUT ✓" : "Mark OUT"}</button>
                            )}
                          </div>
                          <div className="row wrap" style={{gap:8, marginTop:10}}>
                            {FIELD_ACTIONS.map(a => (
                              <button
                                key={a.key}
                                className="ghost"
                                onClick={()=>addEvent(p.id, a.key)}
                                disabled={betweenPeriods || subMode || gameEnded}
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {active.filter(p => p.pos !== "GK").length === 0 && (
                      <div className="card" style={{opacity:.7}}>No active field players.</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Box scores */}
              <div className="card" style={{marginBottom:12}}>
                <strong>Field Players</strong>
                <div style={{overflowX:"auto", marginTop:8}}>
                  <table>
                    <thead>
                      <tr>
                        <th align="left">#</th><th align="left">Name</th>
                        <th>Time</th>
                        <th>G</th><th>Att</th><th>Shot%</th>
                        <th>Ast</th><th>Stl</th><th>TO</th>
                        <th>EX</th><th>F-EX</th><th>Blk</th>
                        <th>SwimW</th><th>SwimL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fielders.map(p => {
                        const ex = p.exclusions || 0;
                        const rowStyle = rowStyleByExclusions(ex);
                        const nameStyle = nameStyleByExclusions(ex);
                        const displayNumber = ex >= 3 ? `${p.number} E` : p.number;

                        return (
                          <tr key={p.id} style={rowStyle}>
                            <td className="mono">{displayNumber}</td>
                            <td style={nameStyle}>{p.name}</td>
                            <td className="mono" align="center">{fmtMMSS(p.timePlayedSec)}</td>
                            <td align="center">{p.goals}</td>
                            <td align="center">{p.attempts}</td>
                            <td align="center">{p.shotPct}</td>
                            <td align="center">{p.assists}</td>
                            <td align="center">{p.steals}</td>
                            <td align="center">{p.turnovers}</td>
                            <td align="center">{p.exclusions}</td>
                            <td align="center">{p.forcedExclusions}</td>
                            <td align="center">{p.blocks}</td>
                            <td align="center">{p.swimWins}</td>
                            <td align="center">{p.swimLosses}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <strong>Goalkeepers</strong>
                <div style={{overflowX:"auto", marginTop:8}}>
                  <table>
                    <thead>
                      <tr>
                        <th align="left">#</th><th align="left">Name</th>
                        <th>Time</th>
                        <th>GA</th><th>Sv</th><th>Save%</th><th>PK Blk</th>
                        <th>Ast</th><th>Stl</th><th>TO</th><th>EX</th><th>F-EX</th>
                      </tr>
                    </thead>
                    <tbody>
                      {goalies.map(p=>{
                        const ex = p.exclusions || 0;
                        const rowStyle = rowStyleByExclusions(ex);
                        const nameStyle = nameStyleByExclusions(ex);
                        const displayNumber = ex >= 3 ? `${p.number} E` : p.number;

                        return (
                          <tr key={p.id} style={rowStyle}>
                            <td className="mono">{displayNumber}</td>
                            <td style={nameStyle}>{p.name}</td>
                            <td className="mono" align="center">{fmtMMSS(p.timePlayedSec)}</td>
                            <td align="center">{p.goalsAgainst}</td>
                            <td align="center">{p.saves}</td>
                            <td align="center">{p.savePct}</td>
                            <td align="center">{p.penaltyBlocks}</td>
                            <td align="center">{p.assists}</td>
                            <td align="center">{p.steals}</td>
                            <td align="center">{p.turnovers}</td>
                            <td align="center">{p.exclusions}</td>
                            <td align="center">{p.forcedExclusions}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Goals Against by opponent number */}
              {gaOppKeys.length > 0 && (
                <div className="card" style={{marginTop:12}}>
                  <strong>Goals Against (by opponent #)</strong>
                  <div style={{overflowX:"auto", marginTop:8}}>
                    <table>
                      <thead>
                        <tr>
                          {gaOppKeys.map(k => (
                            <th key={k} align="center">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          {gaOppKeys.map(k => (
                            <td key={k} align="center">{gaByOpp[k]}</td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: Bench */}
            <aside className="card sidebar">
              <div className="row" style={{justifyContent:"space-between", alignItems:"baseline"}}>
                <strong>Bench</strong>
                <span className="badge">{bench.length}</span>
              </div>
              <p style={{opacity:.7, marginTop:6}}>
                {betweenPeriods
                  ? "Choose 7 starters above, then Start Period."
                  : (subMode ? "Mark IN from the bench to complete your substitution." : "Use Start Substitution or End Period.")}
              </p>
              <div style={{marginTop:8, display:'grid', gap:8}}>
                {bench.map(p=>{
                  const inMarked = subMode && selectedIn.has(p.id);
                  return (
                    <div key={p.id} className="card" style={{padding:'8px 10px', ...(inMarked ? {outline:'3px solid #22c55e'} : {})}}>
                      <div className="row" style={{justifyContent:"space-between"}}>
                        <div><strong>#{p.number}</strong> {p.name} {p.pos==='GK' ? '• GK' : '• FP'}</div>
                        {!betweenPeriods && subMode && (
                          <button onClick={()=>toggleIn(p.id)}>{inMarked ? "IN ✓" : "Mark IN"}</button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {bench.length === 0 && <div className="card" style={{opacity:.7}}>No bench players.</div>}
              </div>
            </aside>
          </div>
          {/* 5️⃣ Team Stats Manual Adjust (only visible in Edit Mode) */}
          {editMode && (
            <div className="card" style={{ marginTop: 12, borderColor: '#eab308' }}>
              <strong>Team Stats — Manual Adjust</strong>

              <div className="grid" style={{ marginTop: 8 }}>
                {/* Man Up */}
                <div className="card">
                  <div><b>Man Up (Offense 6v5)</b></div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Attempts: <b>{teamStats.manUp.attempts}</b></span>
                    <button onClick={() => adjustTeamStat('manUp','attempts',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('manUp','attempts',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Goals: <b>{teamStats.manUp.goals}</b></span>
                    <button onClick={() => adjustTeamStat('manUp','goals',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('manUp','goals',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Stops: <b>{teamStats.manUp.stops}</b></span>
                    <button onClick={() => adjustTeamStat('manUp','stops',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('manUp','stops',+1)}>+</button>
                  </div>
                </div>

                {/* Man Down */}
                <div className="card">
                  <div><b>Man Down (Defense 5v6)</b></div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Defenses: <b>{teamStats.manDown.defenses}</b></span>
                    <button onClick={() => adjustTeamStat('manDown','defenses',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('manDown','defenses',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Stops: <b>{teamStats.manDown.stops}</b></span>
                    <button onClick={() => adjustTeamStat('manDown','stops',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('manDown','stops',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>GA: <b>{teamStats.manDown.goalsAgainst}</b></span>
                    <button onClick={() => adjustTeamStat('manDown','goalsAgainst',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('manDown','goalsAgainst',+1)}>+</button>
                  </div>
                </div>

                {/* Penalties For */}
                <div className="card">
                  <div><b>Penalties — For</b></div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Attempts: <b>{teamStats.penFor.attempts}</b></span>
                    <button onClick={() => adjustTeamStat('penFor','attempts',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('penFor','attempts',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Goals: <b>{teamStats.penFor.goals}</b></span>
                    <button onClick={() => adjustTeamStat('penFor','goals',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('penFor','goals',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Misses: <b>{teamStats.penFor.misses}</b></span>
                    <button onClick={() => adjustTeamStat('penFor','misses',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('penFor','misses',+1)}>+</button>
                  </div>
                </div>

                {/* Penalties Against */}
                <div className="card">
                  <div><b>Penalties — Against</b></div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Attempts: <b>{teamStats.penAgainst.attempts}</b></span>
                    <button onClick={() => adjustTeamStat('penAgainst','attempts',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('penAgainst','attempts',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>Saves: <b>{teamStats.penAgainst.saves}</b></span>
                    <button onClick={() => adjustTeamStat('penAgainst','saves',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('penAgainst','saves',+1)}>+</button>
                  </div>

                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <span>GA: <b>{teamStats.penAgainst.goalsAgainst}</b></span>
                    <button onClick={() => adjustTeamStat('penAgainst','goalsAgainst',-1)}>−</button>
                    <button onClick={() => adjustTeamStat('penAgainst','goalsAgainst',+1)}>+</button>
                  </div>
                </div>
              </div>

              <p style={{ opacity: .75, marginTop: 6 }}>
                These change the team counters directly (independent of the per-player event log).
              </p>
            </div>
          )}
          {/* 🗒️ Notes Section (always visible) */}
          <div className="card" style={{ marginTop: 12 }}>
            <strong>Notes</strong>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Write any observations, opponent tendencies, or reminders..."
              rows={6}
              style={{
                width: '100%',
                marginTop: 8,
                padding: 8,
                fontFamily: 'inherit',
                borderRadius: 8,
                border: '1px solid var(--border)',
                resize: 'vertical',
                background: '#fff',
                color: 'var(--text)',
              }}
            />
            <div style={{ opacity: .7, marginTop: 6 }}>
              Auto-saves locally with the rest of your game data.
            </div>
          </div>
          {/* 4️⃣ Editable Event Log (shows when Edit Mode is ON) */}
          {editMode && (
            <div className="card" style={{ marginTop: 12, borderColor: '#eab308' }}>
              <strong>Event Log (editable)</strong>
              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Period</th>
                      <th>Clock</th>
                      <th>Player</th>
                      <th>Type</th>
                      <th align="right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...log].reverse().map(e => {
                      const player = roster.find(p => p.id === e.playerId);
                      const label = EVENT_TYPES.find(t => t.key === e.type)?.label ?? e.type;

                      return (
                        <tr key={e.id}>
                          <td className="mono">{new Date(e.ts).toLocaleTimeString()}</td>
                          <td>
                            <input
                              type="number"
                              style={{ width: 70 }}
                              value={e.period}
                              onChange={ev => updateEvent(e.id, { period: Number(ev.target.value || 1) })}
                            />
                          </td>
                          <td>
                            <input
                              className="mono"
                              style={{ width: 90 }}
                              value={e.clock}
                              onChange={ev => {
                                const s = parseClockMMSS(ev.target.value);
                                updateEvent(e.id, { clock: s != null ? fmtMMSS(s) : ev.target.value });
                              }}
                            />
                          </td>
                          <td>
                            <select
                              value={e.playerId}
                              onChange={ev => updateEvent(e.id, { playerId: ev.target.value })}
                            >
                              {roster.map(p => (
                                <option key={p.id} value={p.id}>
                                  #{p.number} {p.name} {p.pos === 'GK' ? '• GK' : '• FP'}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              value={e.type}
                              onChange={ev => updateEvent(e.id, { type: ev.target.value })}
                            >
                              {EVENT_TYPES.map(t => (
                                <option key={t.key} value={t.key}>{t.label}</option>
                              ))}
                            </select>
                          </td>
                          <td align="right">
                            <button className="ghost" onClick={() => removeEvent(e.id)}>Delete</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p style={{ opacity: .75, marginTop: 6 }}>
                Use this to fix stats: delete saves, reassign assists, or adjust timing.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
  
}
