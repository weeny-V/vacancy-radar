"use client";

import { Bell, Bookmark, EyeOff, Play, Radar, Save, Send } from "lucide-react";
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

const splitList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export default function Page() {
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [runs, setRuns] = useState<FetchRun[]>([]);
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
    const [vacanciesResponse, runsResponse, profileResponse] = await Promise.all([
      fetch(`${API_URL}/vacancies`).then((response) => response.json()),
      fetch(`${API_URL}/admin/fetch-runs`).then((response) => response.json()),
      fetch(`${API_URL}/profiles/me`).then((response) => response.json()).catch(() => null)
    ]);
    setVacancies(vacanciesResponse);
    setRuns(runsResponse);
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
    refresh().catch((error) => setStatus(error.message));
  }, []);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setStatus("Saving profile");
    await fetch(`${API_URL}/profiles`, {
      method: "POST",
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: telegramChatId })
    });
    setStatus("Telegram connected");
  }

  async function runFetch() {
    setStatus("Fetch queued");
    await fetch(`${API_URL}/admin/fetch-runs/run`, { method: "POST" });
    setTimeout(() => refresh().catch((error) => setStatus(error.message)), 1200);
  }

  async function updateVacancy(id: string, action: "save" | "ignore") {
    await fetch(`${API_URL}/vacancies/${id}/${action}`, { method: "POST" });
    await refresh();
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
