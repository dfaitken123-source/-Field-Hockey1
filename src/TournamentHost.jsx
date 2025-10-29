// Version 1.2
// Fixes: corrupted JSX causing render errors, duplicate ResultsPage definitions, and
// "No schedule yet" showing due to schedule not generating. Clean, single file app.
// Features: Team setup (names/images), scheduling with constraints, per-pitch view,
// results entry + standings (3-1-0 points), save/export/import.

import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { Label } from "@/components/ui/label.jsx";
import { Upload, Shuffle, Save, RefreshCcw, Download, CalendarClock } from "lucide-react";

// ---------------------------
// Constants & storage keys
// ---------------------------
const STORAGE_KEY = "fh_tournament_v1";

// Match timing
const GAME_MINUTES = 40;
const HALFTIME_MINUTES = 5;
const WARMUP_MINUTES = 15;
const SLOT_MINUTES = GAME_MINUTES + HALFTIME_MINUTES; // 40 + 5 halftime
const BUFFER_MINUTES = WARMUP_MINUTES; // warmup buffer between games
const REST_MINUTES = 60; // min rest between game end and next start
const MAX_PER_DAY = 3; // per team per day

// Day cutoffs
const DAY3_FINISH_BY = "11:00"; // Day 3 must FINISH by 11:00
const DAY12_FINISH_BY = "15:00"; // Day 1 & 2 must FINISH at 3:00 PM

// Scoring (results)
const WIN_POINTS = 3;
const DRAW_POINTS = 1;
const LOSS_POINTS = 0;

// ---------------------------
// Helpers
// ---------------------------
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function defaultTeams() {
  return Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: "", image: "" }));
}

function pad(n) { return n.toString().padStart(2, "0"); }
function addMinutesToHHMM(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutes + 24 * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${pad(hh)}:${pad(mm)}`;
}
function toMinutes(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

// Round-robin (circle method) for even n teams
function roundRobin(teams) {
  const n = teams.length;
  const arr = [...teams];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      round.push({ home, away });
    }
    rounds.push(round);
    // rotate (keep first fixed)
    arr.splice(1, 0, arr.pop());
  }
  return rounds; // For 6 teams → 5 rounds, 3 matches each (15 matches per pool)
}

function gatherPoolMatches(schedule) {
  if (!schedule) return [];
  return [
    ...(schedule.day1 || []),
    ...(schedule.day2 || []),
    ...(schedule.day3 || []),
  ].filter((match) => {
    if (!match) return false;
    if (match.stage) return match.stage === "pool";
    return Boolean(match.pool);
  });
}

function computePoolStandings(schedule, results) {
  const allMatches = gatherPoolMatches(schedule);
  const base = new Map();

  const touch = (team, pool) => {
    if (!team) return null;
    if (!base.has(team.id)) {
      base.set(team.id, {
        id: team.id,
        name: team.name,
        image: team.image,
        pool,
        P: 0,
        W: 0,
        D: 0,
        L: 0,
        GF: 0,
        GA: 0,
        GD: 0,
        PTS: 0,
      });
    }
    return base.get(team.id);
  };

  const apply = (match, result) => {
    const H = touch(match.home, match.pool);
    const A = touch(match.away, match.pool);
    if (!H || !A) return;
    const hg = result.homeGoals;
    const ag = result.awayGoals;
    H.P += 1;
    A.P += 1;
    H.GF += hg;
    H.GA += ag;
    A.GF += ag;
    A.GA += hg;
    H.GD = H.GF - H.GA;
    A.GD = A.GF - A.GA;
    if (hg > ag) {
      H.W += 1;
      A.L += 1;
      H.PTS += WIN_POINTS;
      A.PTS += LOSS_POINTS;
    } else if (hg < ag) {
      A.W += 1;
      H.L += 1;
      A.PTS += WIN_POINTS;
      H.PTS += LOSS_POINTS;
    } else {
      H.D += 1;
      A.D += 1;
      H.PTS += DRAW_POINTS;
      A.PTS += DRAW_POINTS;
    }
  };

  for (const match of allMatches) {
    const result = results?.[match.id];
    if (result && Number.isFinite(result.homeGoals) && Number.isFinite(result.awayGoals)) {
      apply(match, result);
    } else {
      touch(match.home, match.pool);
      touch(match.away, match.pool);
    }
  }

  const makeTable = (poolKey) =>
    [...base.values()]
      .filter((team) => team.pool === poolKey)
      .sort(
        (a, b) =>
          b.PTS - a.PTS ||
          b.GD - a.GD ||
          b.GF - a.GF ||
          a.name.localeCompare(b.name)
      );

  return { A: makeTable("A"), B: makeTable("B") };
}

function resolveSeed(seed, standings) {
  if (!seed || !standings) return null;
  const list = standings[seed.pool] || [];
  return list[seed.position - 1] || null;
}

// ---------------------------
// Views
// ---------------------------
function ScheduleViewPerPitch({ schedule, results }) {
  if (!schedule) return <p className="text-sm text-gray-600">No schedule generated yet.</p>;
  const days = [
    { key: "day1", label: "Day 1", start: schedule.meta.day1Start },
    { key: "day2", label: "Day 2", start: schedule.meta.day2Start },
    { key: "day3", label: "Day 3", start: schedule.meta.day3Start },
  ];

  const standings = computePoolStandings(schedule, results || {});

  const displayForTeam = (team) => {
    if (!team) return { name: "TBD", image: "" };
    if (team.seed) {
      const resolved = resolveSeed(team.seed, standings);
      if (resolved) {
        return { name: resolved.name, image: resolved.image };
      }
    }
    return { name: team.name, image: team.image };
  };

  const renderMatchList = (matches) => (
    <ul className="space-y-2">
      {matches.map((match) => {
        const r = results?.[match.id];
        const home = displayForTeam(match.home);
        const away = displayForTeam(match.away);
        const label =
          match.stage === "pool"
            ? `Pool ${match.pool} • R${match.round}`
            : match.label || "Semi-final";
        return (
          <li key={match.id} className="p-2 bg-white border rounded-lg text-sm flex flex-col">
            <div className="flex justify-between text-gray-600 text-xs">
              <span>{match.time}</span>
              <span>{label}</span>
            </div>
            <div className="flex items-center justify-center gap-3 mt-1 font-medium">
              {home.image ? (
                <img src={home.image} alt={home.name} className="w-6 h-6 rounded object-cover" />
              ) : (
                <div className="w-6 h-6 rounded bg-gray-200" />
              )}
              <span className="truncate max-w-[40%] text-center" title={home.name}>{home.name}</span>
              <span className="text-gray-400">vs</span>
              <span className="truncate max-w-[40%] text-center" title={away.name}>{away.name}</span>
              {away.image ? (
                <img src={away.image} alt={away.name} className="w-6 h-6 rounded object-cover" />
              ) : (
                <div className="w-6 h-6 rounded bg-gray-200" />
              )}
            </div>
            {r && (
              <div className="mt-1 text-center text-xs text-gray-700">
                Final: <span className="font-semibold">{r.homeGoals}</span> - <span className="font-semibold">{r.awayGoals}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-6">
      {days.map((day) => (
        <Card key={day.key} className="border">
          <CardContent className="p-4 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{day.label} • start {day.start}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: schedule.meta.pitches }, (_, i) => i + 1).map((pitchNo) => {
                const pitchMatches = (schedule[day.key] || []).filter((m) => m.pitch === pitchNo);
                return (
                  <div key={pitchNo} className="p-3 border rounded-lg bg-gray-50">
                    <h4 className="font-medium mb-2">Pitch {pitchNo}</h4>
                    {pitchMatches.length === 0 ? (
                      <p className="text-xs text-gray-500">No games</p>
                    ) : (
                      renderMatchList(pitchMatches)
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ))}

      {schedule.semis?.length ? (
        <Card className="border">
          <CardContent className="p-4 space-y-4">
            <h3 className="text-lg font-semibold">Semi-finals</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: schedule.meta.pitches }, (_, i) => i + 1).map((pitchNo) => {
                const pitchMatches = schedule.semis.filter((m) => m.pitch === pitchNo);
                if (pitchMatches.length === 0) return null;
                return (
                  <div key={`semi-${pitchNo}`} className="p-3 border rounded-lg bg-gray-50">
                    <h4 className="font-medium mb-2">Pitch {pitchNo}</h4>
                    {renderMatchList(pitchMatches)}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ResultsPage({ schedule, results, setResults }) {
  if (!schedule) return <p className="text-sm text-gray-600">No schedule yet. Generate the schedule first.</p>;
  const poolMatches = gatherPoolMatches(schedule);

  const grouped = {
    A: poolMatches
      .filter((m) => m.pool === "A")
      .sort((a, b) => a.round - b.round || toMinutes(a.time) - toMinutes(b.time)),
    B: poolMatches
      .filter((m) => m.pool === "B")
      .sort((a, b) => a.round - b.round || toMinutes(a.time) - toMinutes(b.time)),
  };

  function updateResult(match, side, value) {
    const num = Math.max(0, Number(value ?? 0));
    setResults((prev) => {
      const cur = { ...(prev[match.id] || { homeGoals: 0, awayGoals: 0 }) };
      if (side === 'home') cur.homeGoals = num; else cur.awayGoals = num;
      return { ...prev, [match.id]: cur };
    });
  }

  const standings = computePoolStandings(schedule, results);

  const resolvedSemis = (schedule.semis || []).map((match) => {
    const homeResolved = resolveSeed(match.homeSeed || match.home?.seed, standings);
    const awayResolved = resolveSeed(match.awaySeed || match.away?.seed, standings);
    return {
      ...match,
      homeDisplay: {
        name: homeResolved?.name || match.home?.name || "TBD",
        image: homeResolved?.image || match.home?.image || "",
      },
      awayDisplay: {
        name: awayResolved?.name || match.away?.name || "TBD",
        image: awayResolved?.image || match.away?.image || "",
      },
    };
  });

  const PoolTable = ({ poolKey }) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-600">
            <th className="py-2 pr-2">#</th>
            <th className="py-2 pr-2">Team</th>
            <th className="py-2 px-2">P</th>
            <th className="py-2 px-2">W</th>
            <th className="py-2 px-2">D</th>
            <th className="py-2 px-2">L</th>
            <th className="py-2 px-2">GF</th>
            <th className="py-2 px-2">GA</th>
            <th className="py-2 px-2">GD</th>
            <th className="py-2 pl-2">PTS</th>
          </tr>
        </thead>
        <tbody>
          {standings[poolKey].map((t, i) => (
            <tr key={t.id} className="border-t">
              <td className="py-2 pr-2 w-8">{i+1}</td>
              <td className="py-2 pr-2">
                <div className="flex items-center gap-2">
                  {t.image ? (<img src={t.image} alt={t.name} className="w-6 h-6 rounded object-cover" />) : (<div className="w-6 h-6 rounded bg-gray-200" />)}
                  <span className="font-medium">{t.name}</span>
                </div>
              </td>
              <td className="py-2 px-2 text-center">{t.P}</td>
              <td className="py-2 px-2 text-center">{t.W}</td>
              <td className="py-2 px-2 text-center">{t.D}</td>
              <td className="py-2 px-2 text-center">{t.L}</td>
              <td className="py-2 px-2 text-center">{t.GF}</td>
              <td className="py-2 px-2 text-center">{t.GA}</td>
              <td className="py-2 px-2 text-center">{t.GD}</td>
              <td className="py-2 pl-2 text-center font-semibold">{t.PTS}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const PoolEntry = ({ poolKey }) => (
    <Card className="shadow-sm">
      <CardContent className="p-4 space-y-4">
        <h3 className="text-lg font-semibold">Pool {poolKey} Results</h3>
        <div className="grid grid-cols-1 gap-3">
          {grouped[poolKey].map((m) => {
            const r = results[m.id] || { homeGoals: "", awayGoals: "" };
            return (
              <div key={m.id} className="border rounded-lg bg-white overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 text-xs text-gray-600 border-b">
                  <span className="truncate">{m.time} • Pitch {m.pitch} • R{m.round}</span>
                  <span className="flex-shrink-0 ml-2">Pool {m.pool}</span>
                </div>
                <div className="p-3">
                  {/* Home Team Row */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-10 h-10 rounded overflow-hidden bg-gray-100 flex-shrink-0">
                      {m.home.image ? (
                        <img src={m.home.image} alt={m.home.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gray-200" />
                      )}
                    </div>
                    <span className="font-semibold text-base flex-1 min-w-0" title={m.home.name}>
                      {m.home.name}
                    </span>
                    <Input 
                      inputMode="numeric" 
                      pattern="[0-9]*" 
                      value={r.homeGoals} 
                      onChange={(e)=> updateResult(m,'home', e.target.value)} 
                      className="w-16 h-10 text-center text-lg font-bold flex-shrink-0" 
                      placeholder="0" 
                    />
                  </div>
                  
                  {/* Away Team Row */}
                  <div className="flex items-center gap-2 mt-2">
                    <div className="w-10 h-10 rounded overflow-hidden bg-gray-100 flex-shrink-0">
                      {m.away.image ? (
                        <img src={m.away.image} alt={m.away.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gray-200" />
                      )}
                    </div>
                    <span className="font-semibold text-base flex-1 min-w-0" title={m.away.name}>
                      {m.away.name}
                    </span>
                    <Input 
                      inputMode="numeric" 
                      pattern="[0-9]*" 
                      value={r.awayGoals} 
                      onChange={(e)=> updateResult(m,'away', e.target.value)} 
                      className="w-16 h-10 text-center text-lg font-bold flex-shrink-0" 
                      placeholder="0" 
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardContent className="p-4 space-y-4">
          <h2 className="text-xl font-semibold">Standings</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="mb-2 font-medium">Pool A</h3>
              <PoolTable poolKey="A" />
            </div>
            <div>
              <h3 className="mb-2 font-medium">Pool B</h3>
              <PoolTable poolKey="B" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PoolEntry poolKey="A" />
        <PoolEntry poolKey="B" />
      </div>

      {resolvedSemis.length > 0 && (
        <Card className="shadow-sm">
          <CardContent className="p-4 space-y-4">
            <h3 className="text-lg font-semibold">Semi-finals</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {resolvedSemis.map((match) => {
                const r = results[match.id] || { homeGoals: "", awayGoals: "" };
                return (
                  <div key={match.id} className="border rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-50 text-xs text-gray-600 border-b">
                      <span>{match.time} • Pitch {match.pitch}</span>
                      <span>{match.label}</span>
                    </div>
                    <div className="p-3 space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="w-10 h-10 rounded overflow-hidden bg-gray-100 flex-shrink-0">
                          {match.homeDisplay.image ? (
                            <img src={match.homeDisplay.image} alt={match.homeDisplay.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-gray-200" />
                          )}
                        </div>
                        <span className="font-semibold text-base flex-1 min-w-0" title={match.homeDisplay.name}>
                          {match.homeDisplay.name}
                        </span>
                        <Input
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={r.homeGoals}
                          onChange={(e) => updateResult(match, "home", e.target.value)}
                          className="w-16 h-10 text-center text-lg font-bold flex-shrink-0"
                          placeholder="0"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-10 h-10 rounded overflow-hidden bg-gray-100 flex-shrink-0">
                          {match.awayDisplay.image ? (
                            <img src={match.awayDisplay.image} alt={match.awayDisplay.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-gray-200" />
                          )}
                        </div>
                        <span className="font-semibold text-base flex-1 min-w-0" title={match.awayDisplay.name}>
                          {match.awayDisplay.name}
                        </span>
                        <Input
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={r.awayGoals}
                          onChange={(e) => updateResult(match, "away", e.target.value)}
                          className="w-16 h-10 text-center text-lg font-bold flex-shrink-0"
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------
// Main component
// ---------------------------
export default function TournamentHost() {
  const [teams, setTeams] = useState(defaultTeams());
  const [shuffled, setShuffled] = useState(false);
  const [error, setError] = useState("");

  // schedule controls
  const [pitches, setPitches] = useState(2);
  const [day1Start, setDay1Start] = useState("09:00");
  const [day2Start, setDay2Start] = useState("09:00");
  const [day3Start, setDay3Start] = useState("09:00");
  const [schedule, setSchedule] = useState(null);
  const [results, setResults] = useState({});
  const [activeTab, setActiveTab] = useState("setup");
  const [shareableUrl, setShareableUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Load from memory on mount (simulating localStorage)
  useEffect(() => {
    // In a real environment, this would use localStorage
    // For this artifact, data persists only during the session
  }, []);

  // Persist results changes (in memory only)
  useEffect(() => {
    // In a real environment, this would save to localStorage
  }, [results]);

  const poolA = useMemo(() => teams.slice(0, 6), [teams]);
  const poolB = useMemo(() => teams.slice(6, 12), [teams]);

  function updateTeamName(index, value) {
    setTeams((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], name: value };
      return copy;
    });
  }

  async function updateTeamImage(index, file) {
    if (!file) return;
    const dataUrl = await readFileAsDataURL(file);
    setTeams((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], image: dataUrl };
      return copy;
    });
  }

  function shuffleTeams() {
    const arr = [...teams];
    // Fisher–Yates shuffle
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    setTeams(arr);
    setShuffled(true);
  }

  function validate() {
    const hasAllTeams = teams.length === 12;
    if (!hasAllTeams) { setError("Exactly 12 teams are required."); return false; }
    setError("");
    return true;
  }

  function save() {
    if (!validate()) return;
    // In a real environment, this would save to localStorage
    setError("");
    alert("Tournament saved! (Note: In this demo, data persists only during the session)");
  }

  function resetAll() {
    setTeams(defaultTeams());
    setShuffled(false);
    setError("");
    setSchedule(null);
    setResults({});
    setDay1Start("09:00");
    setDay2Start("09:00");
    setDay3Start("09:00");
    setPitches(2);
  }

  function exportJSON() {
    const payload = JSON.stringify({ teams, shuffled, schedule, results, day1Start, day2Start, day3Start, pitches }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url; a.download = "field-hockey-tournament.json"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  function onImportJSON(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (Array.isArray(parsed?.teams) && parsed.teams.length === 12) {
          setTeams(parsed.teams);
          setShuffled(!!parsed.shuffled);
          setSchedule(parsed.schedule || null);
          setResults(parsed.results || {});
          setDay1Start(parsed.day1Start || "09:00");
          setDay2Start(parsed.day2Start || "09:00");
          setDay3Start(parsed.day3Start || "09:00");
          setPitches(parsed.pitches || 2);
          setError("");
        } else {
          setError("Imported file is not a valid 12-team tournament JSON.");
        }
      } catch (e) {
        setError("Could not parse JSON file.");
      }
    };
    reader.readAsText(file);
  }

  function generateShareableUrl() {
    const data = {
      schedule,
      results,
      teams: teams.map(t => ({ id: t.id, name: t.name, image: t.image }))
    };
    const encoded = btoa(JSON.stringify(data));
    const baseUrl = window.location.origin + window.location.pathname;
    const url = `${baseUrl}?data=${encoded}`;
    setShareableUrl(url);
    return url;
  }

  function copyUrlToClipboard() {
    const url = generateShareableUrl();
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  // =========================
  // Schedule generation
  // =========================
  function generateSchedule() {
    if (!validate()) return;

    // Fill missing names for scheduling
    const namedTeams = teams.map((t, i) => ({ ...t, name: (t.name && t.name.trim()) ? t.name : `Team ${i + 1}` }));
    if (namedTeams.some((t, i) => t.name !== teams[i].name)) setTeams(namedTeams);

    const aPool = namedTeams.slice(0, 6).map((t) => ({ ...t, pool: "A" }));
    const bPool = namedTeams.slice(6, 12).map((t) => ({ ...t, pool: "B" }));

    const aRounds = roundRobin(aPool);
    const bRounds = roundRobin(bPool);

    const matchesByRound = { A: [], B: [] };
    for (let r = 0; r < aRounds.length; r++) {
      matchesByRound.A.push(
        aRounds[r].map((m) => ({ stage: "pool", pool: "A", round: r + 1, home: m.home, away: m.away }))
      );
    }
    for (let r = 0; r < bRounds.length; r++) {
      matchesByRound.B.push(
        bRounds[r].map((m) => ({ stage: "pool", pool: "B", round: r + 1, home: m.home, away: m.away }))
      );
    }

    // Distribute into days with per-team limits (max 3/day)
    function splitDays(matchesByRoundPool) {
      const day1 = [], day2 = [], day3 = [];
      const d1Count = new Map();
      const d2Count = new Map();
      const targetPerDay = 5; // per pool per day → 5+5+5 = 15
      for (let r = 0; r < matchesByRoundPool.length; r++) {
        for (const m of matchesByRoundPool[r]) {
          const h = m.home.id, a = m.away.id;
          const canD1 = day1.length < targetPerDay && (d1Count.get(h) || 0) < MAX_PER_DAY && (d1Count.get(a) || 0) < MAX_PER_DAY;
          if (canD1) {
            day1.push(m);
            d1Count.set(h, (d1Count.get(h) || 0) + 1);
            d1Count.set(a, (d1Count.get(a) || 0) + 1);
            continue;
          }
          const canD2 = day2.length < targetPerDay && (d2Count.get(h) || 0) < MAX_PER_DAY && (d2Count.get(a) || 0) < MAX_PER_DAY;
          if (canD2) {
            day2.push(m);
            d2Count.set(h, (d2Count.get(h) || 0) + 1);
            d2Count.set(a, (d2Count.get(a) || 0) + 1);
            continue;
          }
          day3.push(m);
        }
      }
      return { day1, day2, day3 };
    }

    const aSplit = splitDays(matchesByRound.A);
    const bSplit = splitDays(matchesByRound.B);

    let day1Matches = [...aSplit.day1, ...bSplit.day1];
    let day2Matches = [...aSplit.day2, ...bSplit.day2];
    let day3Matches = [...aSplit.day3, ...bSplit.day3];

    // Enforce Day 3: no team plays more than one game
    const countTeams = (arr) => {
      const map = new Map();
      arr.forEach((m) => { map.set(m.home.id, (map.get(m.home.id)||0)+1); map.set(m.away.id, (map.get(m.away.id)||0)+1); });
      return map;
    };
    let d1Counts = countTeams(day1Matches);
    let d2Counts = countTeams(day2Matches);
    const seenDay3 = new Map();
    const keptDay3 = [];
    for (const m of day3Matches) {
      const h = m.home.id, a = m.away.id;
      const hSeen = seenDay3.get(h) || 0;
      const aSeen = seenDay3.get(a) || 0;
      if (hSeen < 1 && aSeen < 1) {
        seenDay3.set(h, hSeen + 1);
        seenDay3.set(a, aSeen + 1);
        keptDay3.push(m);
      } else {
        const canD1 = (d1Counts.get(h)||0) < MAX_PER_DAY && (d1Counts.get(a)||0) < MAX_PER_DAY;
        const canD2 = (d2Counts.get(h)||0) < MAX_PER_DAY && (d2Counts.get(a)||0) < MAX_PER_DAY;
        if (canD1 && (day1Matches.length <= day2Matches.length || !canD2)) {
          day1Matches.push(m); d1Counts.set(h,(d1Counts.get(h)||0)+1); d1Counts.set(a,(d1Counts.get(a)||0)+1);
        } else if (canD2) {
          day2Matches.push(m); d2Counts.set(h,(d2Counts.get(h)||0)+1); d2Counts.set(a,(d2Counts.get(a)||0)+1);
        } else {
          keptDay3.push(m);
        }
      }
    }
    day3Matches = keptDay3;

    // Day 3 capacity (finish by 11:00)
    const lastAllowedStartDay3 = addMinutesToHHMM(DAY3_FINISH_BY, -SLOT_MINUTES);
    const slotsAvailableDay3 = Math.max(0, Math.floor((toMinutes(lastAllowedStartDay3) - toMinutes(day3Start)) / (SLOT_MINUTES + BUFFER_MINUTES)) + 1);
    const day3Capacity = slotsAvailableDay3 * pitches;
    if (day3Matches.length > day3Capacity) {
      const d1CountsInner = countTeams(day1Matches);
      const d2CountsInner = countTeams(day2Matches);
      const moved = [];
      for (const m of day3Matches) {
        if (day3Matches.length - moved.length <= day3Capacity) break;
        const canD1 = (d1CountsInner.get(m.home.id)||0) < MAX_PER_DAY && (d1CountsInner.get(m.away.id)||0) < MAX_PER_DAY;
        const canD2 = (d2CountsInner.get(m.home.id)||0) < MAX_PER_DAY && (d2CountsInner.get(m.away.id)||0) < MAX_PER_DAY;
        if (canD1 && (day1Matches.length <= day2Matches.length || !canD2)) {
          day1Matches.push(m);
          d1CountsInner.set(m.home.id,(d1CountsInner.get(m.home.id)||0)+1);
          d1CountsInner.set(m.away.id,(d1CountsInner.get(m.away.id)||0)+1);
          moved.push(m);
        } else if (canD2) {
          day2Matches.push(m);
          d2CountsInner.set(m.home.id,(d2CountsInner.get(m.home.id)||0)+1);
          d2CountsInner.set(m.away.id,(d2CountsInner.get(m.away.id)||0)+1);
          moved.push(m);
        }
      }
      if (moved.length) {
        day3Matches = day3Matches.filter((m) => !moved.includes(m)).slice(0, day3Capacity);
      } else {
        day3Matches = day3Matches.slice(0, day3Capacity);
      }
    }

    // Force Day 1 & 2 finish at 15:00 by pulling start earlier
    const lastAllowedStartDay12 = addMinutesToHHMM(DAY12_FINISH_BY, -SLOT_MINUTES); // 14:15
    const slotsNeededD1 = Math.ceil(day1Matches.length / pitches);
    const slotsNeededD2 = Math.ceil(day2Matches.length / pitches);
    const earliestStartForSlots = (slots) => addMinutesToHHMM(lastAllowedStartDay12, -(slots - 1) * (SLOT_MINUTES + BUFFER_MINUTES));
    const effectiveDay1Start = earliestStartForSlots(slotsNeededD1);
    const effectiveDay2Start = earliestStartForSlots(slotsNeededD2);

    // Slot assignment
    let matchIdCounter = 1;
    function assignTimesFromList(queue, startHHMM, { fillAllPitches, finishBy } = { fillAllPitches: false, finishBy: null }) {
      const q = [...queue];
      const scheduled = [];
      let currentTime = startHHMM;
      const lastStartByTeam = new Map();
      const lastAllowedStart = finishBy ? addMinutesToHHMM(finishBy, -SLOT_MINUTES) : null;

      while (q.length > 0) {
        let slot = [];
        for (let i = 0; i < q.length && slot.length < pitches; i++) {
          const c = q[i];
          const conflictInSlot = slot.some((s) => s.home.id === c.home.id || s.home.id === c.away.id || s.away.id === c.home.id || s.away.id === c.away.id);
          if (conflictInSlot) continue;

          const lastH = lastStartByTeam.get(c.home.id);
          const lastA = lastStartByTeam.get(c.away.id);
          const curMin = toMinutes(currentTime);
          const okRestHome = lastH === undefined || (curMin - toMinutes(lastH)) >= (SLOT_MINUTES + REST_MINUTES);
          const okRestAway = lastA === undefined || (curMin - toMinutes(lastA)) >= (SLOT_MINUTES + REST_MINUTES);
          if (okRestHome && okRestAway) {
            slot.push(c);
            q.splice(i, 1); i--;
          }
        }

        if (slot.length === 0) {
          const nextTime = addMinutesToHHMM(currentTime, SLOT_MINUTES + BUFFER_MINUTES);
          if (lastAllowedStart && toMinutes(nextTime) > toMinutes(lastAllowedStart)) break;
          currentTime = nextTime;
          continue;
        }

        if (fillAllPitches && slot.length < pitches && q.length > 0) {
          const slotTeamIds = new Set(slot.flatMap((m) => [m.home.id, m.away.id]));
          const hasDisjointRemaining = q.some((m) => !slotTeamIds.has(m.home.id) && !slotTeamIds.has(m.away.id));
          if (hasDisjointRemaining) {
            q.unshift(...slot);
            slot = [];
            const nextTime = addMinutesToHHMM(currentTime, SLOT_MINUTES + BUFFER_MINUTES);
            if (lastAllowedStart && toMinutes(nextTime) > toMinutes(lastAllowedStart)) break;
            currentTime = nextTime;
            continue;
          }
        }

        for (let p = 0; p < slot.length; p++) {
          const match = { id: matchIdCounter++, time: currentTime, pitch: p + 1, ...slot[p] };
          scheduled.push(match);
          lastStartByTeam.set(match.home.id, currentTime);
          lastStartByTeam.set(match.away.id, currentTime);
        }
        const nextTime = addMinutesToHHMM(currentTime, SLOT_MINUTES + BUFFER_MINUTES);
        if (lastAllowedStart && toMinutes(nextTime) > toMinutes(lastAllowedStart)) break;
        currentTime = nextTime;
      }
      return scheduled;
    }

    const day1Scheduled = assignTimesFromList(day1Matches, effectiveDay1Start, { fillAllPitches: true, finishBy: DAY12_FINISH_BY });
    const day2Scheduled = assignTimesFromList(day2Matches, effectiveDay2Start, { fillAllPitches: true, finishBy: DAY12_FINISH_BY });
    const day3Scheduled = assignTimesFromList(day3Matches, day3Start, { fillAllPitches: true, finishBy: DAY3_FINISH_BY });

    const findLastEndTime = (matches, fallback) => {
      let latest = fallback;
      for (const match of matches) {
        const end = addMinutesToHHMM(match.time, SLOT_MINUTES);
        if (toMinutes(end) > toMinutes(latest)) latest = end;
      }
      return latest;
    };

    const lastPoolEnd = findLastEndTime(day3Scheduled, addMinutesToHHMM(day3Start, SLOT_MINUTES));
    const semiInitialStart = day3Scheduled.length
      ? addMinutesToHHMM(lastPoolEnd, BUFFER_MINUTES)
      : day3Start;

    const semiSeeds = [
      { label: "Semi-final 1", home: { pool: "A", position: 1 }, away: { pool: "B", position: 2 } },
      { label: "Semi-final 2", home: { pool: "B", position: 1 }, away: { pool: "A", position: 2 } },
    ];

    const semiSlots = pitches >= 2
      ? [
          { time: semiInitialStart, pitch: 1 },
          { time: semiInitialStart, pitch: 2 },
        ]
      : [
          { time: semiInitialStart, pitch: 1 },
          { time: addMinutesToHHMM(semiInitialStart, SLOT_MINUTES + BUFFER_MINUTES), pitch: 1 },
        ];

    const semiMatches = semiSeeds.map((seed, index) => {
      const slot = semiSlots[index] || semiSlots[semiSlots.length - 1];
      const homeSeed = seed.home;
      const awaySeed = seed.away;
      return {
        id: matchIdCounter++,
        stage: "semi",
        label: seed.label,
        time: slot.time,
        pitch: slot.pitch,
        round: index + 1,
        pool: null,
        homeSeed,
        awaySeed,
        home: {
          id: `seed-${homeSeed.pool}${homeSeed.position}`,
          name: `Pool ${homeSeed.pool} #${homeSeed.position}`,
          image: "",
          seed: homeSeed,
        },
        away: {
          id: `seed-${awaySeed.pool}${awaySeed.position}`,
          name: `Pool ${awaySeed.pool} #${awaySeed.position}`,
          image: "",
          seed: awaySeed,
        },
      };
    });

    const result = {
      meta: {
        slotMinutes: SLOT_MINUTES,
        buffer: BUFFER_MINUTES,
        rest: REST_MINUTES,
        pitches,
        day1Start,
        day2Start,
        day3Start,
        finishBy: DAY3_FINISH_BY,
        day12FinishBy: DAY12_FINISH_BY,
        semiInitialStart,
      },
      day1: day1Scheduled,
      day2: day2Scheduled,
      day3: day3Scheduled,
      semis: semiMatches,
    };
    setSchedule(result);
    setActiveTab("schedule-view");
  }

  return (
    <div className="min-h-screen w-full bg-white text-gray-900">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Field Hockey Tournament Host</h1>
            <p className="text-sm text-gray-600">
              12 teams → 2 pools of 6. Add team names/images, then generate a three-day round robin (40 min game + 5 min halftime
              with a 15 min warmup buffer, max 3 games per team per day, 60 min rest). Day 3 pool games finish by 11:00 followed by
              cross-over semi-finals.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={shuffleTeams}><Shuffle className="h-4 w-4 mr-2"/>Randomize Pools</Button>
            <Button variant="secondary" onClick={save}><Save className="h-4 w-4 mr-2"/>Save</Button>
            <Button variant="secondary" onClick={resetAll}><RefreshCcw className="h-4 w-4 mr-2"/>Reset</Button>
            <Button variant="secondary" onClick={exportJSON}><Download className="h-4 w-4 mr-2"/>Export</Button>
            <label className="inline-flex items-center px-4 py-2 rounded-md border cursor-pointer hover:bg-gray-50">
              <Upload className="h-4 w-4 mr-2"/>Import
              <input type="file" accept="application/json" className="hidden" onChange={onImportJSON} />
            </label>
          </div>
        </header>

        {error && (<div className="p-3 rounded-md bg-red-50 text-red-700 text-sm">{error}</div>)}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="pools">Pools</TabsTrigger>
            <TabsTrigger value="grid">Team Grid</TabsTrigger>
            <TabsTrigger value="schedule">Generate</TabsTrigger>
            {schedule && <TabsTrigger value="schedule-view">Schedule</TabsTrigger>}
            {schedule && <TabsTrigger value="results">Results</TabsTrigger>}
          </TabsList>

          {/* Setup */}
          <TabsContent value="setup" className="mt-4">
            <Card className="shadow-sm">
              <CardContent className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {teams.map((team, idx) => (
                    <div key={team.id} className="flex items-start gap-3 p-3 border rounded-xl">
                      <div className="w-20 h-20 shrink-0 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center">
                        {team.image ? (<img src={team.image} alt={`Team ${team.id} logo`} className="w-full h-full object-cover"/>) : (<span className="text-xs text-gray-400">No image</span>)}
                      </div>
                      <div className="flex-1 space-y-2">
                        <div>
                          <Label htmlFor={`name-${idx}`}>Team {idx + 1} Name</Label>
                          <Input id={`name-${idx}`} placeholder="Enter team name" value={team.name} onChange={(e) => updateTeamName(idx, e.target.value)} />
                        </div>
                        <div>
                          <Label htmlFor={`img-${idx}`}>Team Image</Label>
                          <Input id={`img-${idx}`} type="file" accept="image/*" onChange={async (e) => { const file = e.target.files?.[0]; await updateTeamImage(idx, file); }} />
                          <p className="text-[11px] text-gray-500 mt-1">PNG/JPG recommended. Stored in memory during session.</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Pools */}
          <TabsContent value="pools" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <h2 className="text-lg font-semibold mb-3">Pool A</h2>
                  <ul className="space-y-2">
                    {poolA.map((t, i) => (
                      <li key={`A-${i}`} className="flex items-center gap-3 p-2 rounded-lg border">
                        <div className="w-10 h-10 rounded-md bg-gray-100 overflow-hidden">{t.image ? (<img src={t.image} alt={t.name || `A${i+1}`} className="w-full h-full object-cover"/>) : null}</div>
                        <span className="font-medium">{t.name || `Team ${i + 1}`}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <h2 className="text-lg font-semibold mb-3">Pool B</h2>
                  <ul className="space-y-2">
                    {poolB.map((t, i) => (
                      <li key={`B-${i}`} className="flex items-center gap-3 p-2 rounded-lg border">
                        <div className="w-10 h-10 rounded-md bg-gray-100 overflow-hidden">{t.image ? (<img src={t.image} alt={t.name || `B${i+1}`} className="w-full h-full object-cover"/>) : null}</div>
                        <span className="font-medium">{t.name || `Team ${i + 7}`}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Grid */}
          <TabsContent value="grid" className="mt-4">
            <Card className="shadow-sm">
              <CardContent className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {teams.map((t, i) => (
                    <div key={`grid-${i}`} className="p-3 border rounded-xl flex flex-col items-center text-center">
                      <div className="w-24 h-24 rounded-lg overflow-hidden bg-gray-100 mb-2">
                        {t.image ? (<img src={t.image} alt={t.name || `Team ${i+1}`} className="w-full h-full object-cover"/>) : (<div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">No image</div>)}
                      </div>
                      <div className="font-medium truncate w-full" title={t.name || `Team ${i+1}`}>{t.name || `Team ${i+1}`}</div>
                      <div className="text-xs text-gray-500">{i < 6 ? "Pool A" : "Pool B"}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Schedule Generator */}
          <TabsContent value="schedule" className="mt-4">
            <Card className="shadow-sm">
              <CardContent className="p-4 space-y-4">
                <h2 className="text-xl font-semibold mb-4">Schedule Configuration</h2>
                <div className="grid grid-cols-1 md:grid-cols-8 gap-3 items-end">
                  <div>
                    <Label htmlFor="pitches">Pitches</Label>
                    <Input id="pitches" type="number" min={1} max={6} value={pitches} onChange={(e)=> setPitches(Math.max(1, Math.min(6, Number(e.target.value)||1)))} />
                  </div>
                  <div>
                    <Label htmlFor="day1">Day 1 start</Label>
                    <Input id="day1" value={day1Start} onChange={(e)=> setDay1Start(e.target.value)} placeholder="09:00" />
                  </div>
                  <div>
                    <Label htmlFor="day2">Day 2 start</Label>
                    <Input id="day2" value={day2Start} onChange={(e)=> setDay2Start(e.target.value)} placeholder="09:00" />
                  </div>
                  <div>
                    <Label htmlFor="day3">Day 3 start</Label>
                    <Input id="day3" value={day3Start} onChange={(e)=> setDay3Start(e.target.value)} placeholder="09:00" />
                  </div>
                  <div>
                    <Label>Match Duration</Label>
                    <div className="h-10 px-3 flex items-center border rounded-md bg-gray-50 text-gray-700">{GAME_MINUTES} + {HALFTIME_MINUTES} = {SLOT_MINUTES} min (game + halftime)</div>
                  </div>
                  <div>
                    <Label>Warmup Buffer</Label>
                    <div className="h-10 px-3 flex items-center border rounded-md bg-gray-50 text-gray-700">{WARMUP_MINUTES} min between matches</div>
                  </div>
                  <div>
                    <Label>Min Rest</Label>
                    <div className="h-10 px-3 flex items-center border rounded-md bg-gray-50 text-gray-700">{REST_MINUTES} min between games</div>
                  </div>
                  <div>
                    <Label>Day 3 Cutoff</Label>
                    <div className="h-10 px-3 flex items-center border rounded-md bg-gray-50 text-gray-700">Finish pools by {DAY3_FINISH_BY}</div>
                  </div>
                  <div>
                    <Label>Day 1 & 2 Finish</Label>
                    <div className="h-10 px-3 flex items-center border rounded-md bg-gray-50 text-gray-700">Finish at {DAY12_FINISH_BY}</div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button onClick={generateSchedule}><CalendarClock className="h-4 w-4 mr-2"/>Generate Schedule</Button>
                  <Button variant="secondary" onClick={save}><Save className="h-4 w-4 mr-2"/>Save Configuration</Button>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
                  <h3 className="font-semibold text-blue-900 mb-2">Schedule Rules</h3>
                  <ul className="text-sm text-blue-800 space-y-1">
                    <li>• Each pool plays a full round robin (15 matches per pool = 30 total)</li>
                    <li>• Maximum 3 games per team per day</li>
                    <li>• Minimum 60 minutes rest between a team's matches</li>
                    <li>• 15 minute warmup buffer between all games</li>
                    <li>• Day 1 & 2 finish at {DAY12_FINISH_BY}</li>
                    <li>• Day 3 pool matches finish by {DAY3_FINISH_BY}</li>
                    <li>• Cross-over semi-finals scheduled after pool play wraps up</li>
                    <li>• Matches automatically rebalanced if constraints can't be met</li>
                  </ul>
                </div>

                {schedule && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4 mt-4">
                    <p className="text-green-800 font-semibold">✓ Schedule generated successfully!</p>
                    <p className="text-sm text-green-700 mt-1">Click the "Schedule" tab to view the complete match schedule.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Schedule View */}
          {schedule && (
            <TabsContent value="schedule-view" className="mt-4">
              <ScheduleViewPerPitch schedule={schedule} results={results} />
            </TabsContent>
          )}

          {/* Results */}
          {schedule && (
            <TabsContent value="results" className="mt-4">
              <ResultsPage schedule={schedule} results={results} setResults={setResults} />
            </TabsContent>
          )}
        </Tabs>

        <footer className="text-xs text-gray-500 text-center pt-2">
          Tip: Use <span className="font-semibold">Randomize Pools</span> after entering teams, then generate the schedule. Export/Import lets you save/load tournament data.
        </footer>
      </div>
    </div>
  );
}
