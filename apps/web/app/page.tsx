"use client";

import { Bell, Bookmark, EyeOff, LogOut, Play, Radar, Save, Send } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { API_URL } from "../lib/api";

type Vacancy = {
  id: string;
  title: string;
  company?: string | null;
  location?: string | null;
  remoteType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  sourceUrl: string;
  status: string;
  source: { name: string };
  matches: Array<{ score: number; reasons: string[]; blocked: boolean }>;
};

type FetchRun = {
  id: string;
  status: string;
  importedCount: number;
  duplicateCount: number;
  matchedCount: number;
  notifiedCount: number;
  failedCount: number;
  error?: string | null;
  startedAt: string;
  source: { name: string };
};

type SourceSetting = {
  id: string;
  name: "DOU" | "DJINNI";
  baseUrl: string;
  searchUrl?: string | null;
  queryLabel?: string | null;
  enabled: boolean;
};

const splitList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

const summarizeFetchRuns = (latestRuns: FetchRun[]) => {
  const imported = latestRuns.reduce((sum, run) => sum + run.importedCount, 0);
  const duplicates = latestRuns.reduce((sum, run) => sum + run.duplicateCount, 0);
  const failed = latestRuns.reduce((sum, run) => sum + run.failedCount, 0);
  const hasRunning = latestRuns.some((run) => run.status === "running");

  if (hasRunning) return "Fetch running";
  if (failed > 0) return `Fetch finished with ${failed} failed item${failed === 1 ? "" : "s"}`;
  if (imported > 0) return `Fetch finished: ${imported} new, ${duplicates} duplicate${duplicates === 1 ? "" : "s"}`;
  return `Fetch finished: no new vacancies, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped`;
};

export default function Page() {
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [runs, setRuns] = useState<FetchRun[]>([]);
  const [sources, setSources] = useState<SourceSetting[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [status, setStatus] = useState("Ready");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [profile, setProfile] = useState({
    role: "Frontend Developer",
    seniority: "Middle",
    skills: "React, TypeScript, Next.js",
    location: "Remote",
    remoteOnly: true,
    salaryMin: 2500,
    salaryCurrency: "USD",
    includeKeywords: "frontend, react",
    excludeKeywords: "wordpress, php",
    matchThreshold: 60
  });

  async function refresh() {
    const [vacanciesResponse, runsResponse, sourcesResponse, profileResponse] = await Promise.all([
      fetch(`${API_URL}/vacancies`, { credentials: "include" }).then((response) => {
        if (response.status === 401) throw new Error("Login required");
        return response.json();
      }),
      fetch(`${API_URL}/admin/fetch-runs`, { credentials: "include" }).then((response) => response.json()),
      fetch(`${API_URL}/sources`, { credentials: "include" }).then((response) => response.json()),
      fetch(`${API_URL}/profiles/me`, { credentials: "include" }).then((response) => response.json()).catch(() => null)
    ]);
    setVacancies(vacanciesResponse);
    setRuns(runsResponse);
    setSources(sourcesResponse);
    if (profileResponse) {
      setProfile({
        role: profileResponse.role,
        seniority: profileResponse.seniority,
        skills: profileResponse.skills.join(", "),
        location: profileResponse.location ?? "",
        remoteOnly: profileResponse.remoteOnly,
        salaryMin: profileResponse.salaryMin ?? 0,
        salaryCurrency: profileResponse.salaryCurrency ?? "USD",
        includeKeywords: profileResponse.includeKeywords.join(", "),
        excludeKeywords: profileResponse.excludeKeywords.join(", "),
        matchThreshold: profileResponse.matchThreshold
      });
    }
  }

  useEffect(() => {
    fetch(`${API_URL}/auth/session`, { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("Login required");
        setIsAuthenticated(true);
        return refresh();
      })
      .catch(() => {
        setIsAuthenticated(false);
        setStatus("Login required");
      });
  }, []);

  async function loginUser(event: FormEvent) {
    event.preventDefault();
    setStatus("Signing in");
    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(login)
    });
    if (!response.ok) {
      setStatus("Invalid email or password");
      return;
    }
    setIsAuthenticated(true);
    setStatus("Signed in");
    await refresh();
  }

  async function logoutUser() {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    setIsAuthenticated(false);
    setStatus("Logged out");
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setStatus("Saving profile");
    await fetch(`${API_URL}/profiles`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...profile,
        skills: splitList(profile.skills),
        includeKeywords: splitList(profile.includeKeywords),
        excludeKeywords: splitList(profile.excludeKeywords),
        salaryMin: Number(profile.salaryMin),
        matchThreshold: Number(profile.matchThreshold)
      })
    });
    setStatus("Profile saved");
    await refresh();
  }

  async function connectTelegram(event: FormEvent) {
    event.preventDefault();
    setStatus("Connecting Telegram");
    await fetch(`${API_URL}/notifications/telegram/connect`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: telegramChatId })
    });
    setStatus("Telegram connected");
  }

  async function saveSource(source: SourceSetting) {
    setStatus(`Saving ${source.name} source`);
    const response = await fetch(`${API_URL}/sources/${source.name}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(source)
    });
    if (!response.ok) {
      setStatus(`${source.name} source save failed`);
      return;
    }
    setStatus(`${source.name} source saved`);
    await refresh();
  }

  async function runFetch() {
    setStatus("Fetch queued");
    await fetch(`${API_URL}/admin/fetch-runs/run`, { method: "POST", credentials: "include" });
    for (const delay of [900, 1800, 3200]) {
      setTimeout(async () => {
        try {
          const [vacanciesResponse, runsResponse] = await Promise.all([
            fetch(`${API_URL}/vacancies`, { credentials: "include" }).then((response) => response.json()),
            fetch(`${API_URL}/admin/fetch-runs`, { credentials: "include" }).then((response) => response.json())
          ]);
          setVacancies(vacanciesResponse);
          setRuns(runsResponse);
          setStatus(summarizeFetchRuns(runsResponse.slice(0, 2)));
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Fetch status failed");
        }
      }, delay);
    }
  }

  async function updateVacancy(id: string, action: "save" | "ignore") {
    await fetch(`${API_URL}/vacancies/${id}/${action}`, { method: "POST", credentials: "include" });
    await refresh();
  }

  if (!isAuthenticated) {
    return (
      <main className="shell auth-shell">
        <section className="panel auth-panel">
          <div className="brand auth-brand">
            <span className="brand-mark"><Radar size={18} /></span>
            <span>Vacancy Radar</span>
          </div>
          <h2>Sign In</h2>
          <form className="form-grid" onSubmit={loginUser}>
            <label>Email<input value={login.email} onChange={(event) => setLogin({ ...login, email: event.target.value })} /></label>
            <label>Password<input type="password" value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} /></label>
            <button className="button" type="submit"><Radar size={16} />Sign in</button>
          </form>
          <p className="status"><Bell size={14} /> {status}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Radar size={18} /></span>
          <span>Vacancy Radar</span>
        </div>
        <div className="actions">
          <button className="button secondary" onClick={refresh}><Radar size={16} />Refresh</button>
          <button className="button" onClick={runFetch}><Play size={16} />Run fetch</button>
          <button className="button secondary" onClick={logoutUser}><LogOut size={16} />Logout</button>
        </div>
      </header>

      <section className="content">
        <aside className="panel">
          <h2>Profile</h2>
          <form className="form-grid" onSubmit={saveProfile}>
            <label>Role<input value={profile.role} onChange={(event) => setProfile({ ...profile, role: event.target.value })} /></label>
            <div className="row">
              <label>Seniority<input value={profile.seniority} onChange={(event) => setProfile({ ...profile, seniority: event.target.value })} /></label>
              <label>Min salary<input type="number" value={profile.salaryMin} onChange={(event) => setProfile({ ...profile, salaryMin: Number(event.target.value) })} /></label>
            </div>
            <label>Skills<textarea value={profile.skills} onChange={(event) => setProfile({ ...profile, skills: event.target.value })} /></label>
            <label>Location<input value={profile.location} onChange={(event) => setProfile({ ...profile, location: event.target.value })} /></label>
            <label className="toggle"><input type="checkbox" checked={profile.remoteOnly} onChange={(event) => setProfile({ ...profile, remoteOnly: event.target.checked })} />Remote only</label>
            <label>Include keywords<textarea value={profile.includeKeywords} onChange={(event) => setProfile({ ...profile, includeKeywords: event.target.value })} /></label>
            <label>Exclude keywords<textarea value={profile.excludeKeywords} onChange={(event) => setProfile({ ...profile, excludeKeywords: event.target.value })} /></label>
            <label>Alert threshold<input type="number" value={profile.matchThreshold} onChange={(event) => setProfile({ ...profile, matchThreshold: Number(event.target.value) })} /></label>
            <button className="button" type="submit"><Save size={16} />Save profile</button>
          </form>

          <h3 style={{ marginTop: 24 }}>Telegram</h3>
          <form className="form-grid" onSubmit={connectTelegram}>
            <label>Chat ID<input value={telegramChatId} onChange={(event) => setTelegramChatId(event.target.value)} /></label>
            <button className="button" type="submit"><Send size={16} />Connect</button>
          </form>

          <h3 style={{ marginTop: 24 }}>Sources</h3>
          <div className="form-grid">
            {sources.map((source) => (
              <div className="source-box" key={source.id}>
                <label>
                  {source.name} search URL
                  <input
                    value={source.searchUrl ?? ""}
                    onChange={(event) => setSources((current) => current.map((item) => (
                      item.id === source.id ? { ...item, searchUrl: event.target.value } : item
                    )))}
                  />
                </label>
                <label>
                  Label
                  <input
                    value={source.queryLabel ?? ""}
                    onChange={(event) => setSources((current) => current.map((item) => (
                      item.id === source.id ? { ...item, queryLabel: event.target.value } : item
                    )))}
                  />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={source.enabled}
                    onChange={(event) => setSources((current) => current.map((item) => (
                      item.id === source.id ? { ...item, enabled: event.target.checked } : item
                    )))}
                  />
                  Enabled
                </label>
                <button className="button secondary" type="button" onClick={() => saveSource(source)}>
                  <Save size={16} />Save {source.name}
                </button>
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: 24 }}>Fetch History</h3>
          <div className="admin-list">
            {runs.map((run) => (
              <div className="fetch-run" key={run.id}>
                <strong>{run.source.name}</strong> {run.status}: imported {run.importedCount}, duplicate {run.duplicateCount}, matched {run.matchedCount}, notified {run.notifiedCount}, failed {run.failedCount}
              </div>
            ))}
          </div>
        </aside>

        <section className="panel">
          <div className="job-head">
            <div>
              <h2>Matched Vacancies</h2>
              <p className="status"><Bell size={14} /> {status}</p>
            </div>
          </div>
          <div className="jobs">
            {vacancies.map((vacancy) => {
              const match = vacancy.matches[0];
              return (
                <article className="job" key={vacancy.id}>
                  <div className="job-head">
                    <div>
                      <h3>{vacancy.title}</h3>
                      <div className="meta">
                        {vacancy.source.name} · {vacancy.company ?? "Company not listed"} · {vacancy.location ?? "Location not listed"} · {vacancy.status}
                      </div>
                    </div>
                    <div className="score">{match ? `${match.score}%` : "New"}</div>
                  </div>
                  <p className="reasons">{match?.reasons.join("; ") ?? "Not scored yet"}</p>
                  <div className="actions">
                    <a className="button secondary" href={vacancy.sourceUrl} target="_blank" rel="noreferrer">Open</a>
                    <button className="button secondary" onClick={() => updateVacancy(vacancy.id, "save")}><Bookmark size={16} />Save</button>
                    <button className="button danger" onClick={() => updateVacancy(vacancy.id, "ignore")}><EyeOff size={16} />Ignore</button>
                  </div>
                </article>
              );
            })}
            {vacancies.length === 0 ? <p className="status">Run a fetch to import DOU and Djinni vacancies.</p> : null}
          </div>
        </section>
      </section>
    </main>
  );
}
