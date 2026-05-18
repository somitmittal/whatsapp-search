import { useState, useCallback, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════
// SCRIPT LOADER
// ═══════════════════════════════════════════════════════════════════
function loadScript(src) {
    return new Promise((res, rej) => {
        if (document.querySelector(`script[src="${src}"]`)) return res();
        const s = document.createElement("script");
        s.src = src; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════════
// FILE PARSERS
// ═══════════════════════════════════════════════════════════════════

/** Decode WhatsApp export bytes (UTF-8, UTF-16 LE/BE, BOM). */
function decodeExportBytes(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!buf.length) return "";
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return new TextDecoder("utf-8").decode(buf.subarray(3));
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(buf.subarray(2));
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const le = new Uint8Array(buf.length - 2);
        for (let i = 2; i + 1 < buf.length; i += 2) {
            le[i - 2] = buf[i + 1];
            le[i - 1] = buf[i];
        }
        return new TextDecoder("utf-16le").decode(le);
    }
    const sample = Math.min(buf.length, 16000);
    let nuls = 0;
    for (let i = 0; i < sample; i++) if (buf[i] === 0) nuls++;
    if (sample > 80 && nuls / sample > 0.08) {
        let s = new TextDecoder("utf-16le").decode(buf);
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        return s;
    }
    return new TextDecoder("utf-8").decode(buf);
}

function scoreZipTxtName(name) {
    const n = String(name).toLowerCase().replace(/\\/g, "/");
    let s = 0;
    if (n.includes("readme")) s -= 200;
    if (/\/_chat\.txt$/.test(n) || n.endsWith("_chat.txt")) s += 120;
    if (n.includes("whatsapp chat")) s += 80;
    if (n.includes("chat with") || n.includes("chat -")) s += 40;
    if (n.includes("__macosx") || /\/\./.test(n)) s -= 500;
    return s;
}

function pickBestZipTxt(files) {
    const txts = Object.entries(files)
        .filter(([name]) => {
            const n = name.toLowerCase().replace(/\\/g, "/");
            return n.endsWith(".txt") && !n.includes("__macosx") && !/\/\./.test(n);
        })
        .sort(([a], [b]) => scoreZipTxtName(b) - scoreZipTxtName(a));

    if (!txts.length) {
        const names = Object.keys(files).slice(0, 15).join(", ") || "(empty)";
        throw new Error(`No .txt in ZIP. Files found: ${names}`);
    }

    let best = null;
    for (const [name, data] of txts) {
        const text = decodeExportBytes(data);
        const msgs = parseTxt(text);
        if (!best || msgs.length > best.msgs.length) {
            best = { text, name, msgs };
        }
    }
    return best;
}

async function loadFflate() {
    if (globalThis.fflate?.unzipSync) return globalThis.fflate;
    await loadScript("https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js");
    if (!globalThis.fflate?.unzipSync) throw new Error("Failed to load ZIP library (check network).");
    return globalThis.fflate;
}

// Native ZIP fallback — central directory + deflate-raw
async function parseZipNative(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const dec = new TextDecoder("utf-8");
    const u16 = o => view.getUint16(o, true);
    const u32 = o => view.getUint32(o, true);

    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("Not a valid ZIP file (EOCD not found).");

    const cdOffset = u32(eocd + 16);
    const cdCount = u16(eocd + 8);
    const entries = [];
    let cdPos = cdOffset;
    for (let i = 0; i < cdCount; i++) {
        if (u32(cdPos) !== 0x02014b50) break;
        const compression = u16(cdPos + 10);
        const compSize = u32(cdPos + 20);
        const uncompSize = u32(cdPos + 24);
        const fnLen = u16(cdPos + 28);
        const exLen = u16(cdPos + 30);
        const cmLen = u16(cdPos + 32);
        const localOff = u32(cdPos + 42);
        const name = dec.decode(bytes.slice(cdPos + 46, cdPos + 46 + fnLen));
        entries.push({ name, compression, compSize, uncompSize, localOff });
        cdPos += 46 + fnLen + exLen + cmLen;
    }
    if (!entries.length) throw new Error("ZIP has no entries.");

    const ranked = entries
        .filter(e => e.name.toLowerCase().endsWith(".txt"))
        .sort((a, b) => scoreZipTxtName(b.name) - scoreZipTxtName(a.name));
    if (!ranked.length) {
        throw new Error(`No .txt in ZIP. Files found: ${entries.map(e => e.name).join(", ")}`);
    }

    async function extractEntry(txtEntry) {
        const lhOff = txtEntry.localOff;
        if (u32(lhOff) !== 0x04034b50) throw new Error("Local file header corrupt.");
        const lhFnLen = u16(lhOff + 26);
        const lhExLen = u16(lhOff + 28);
        const dataStart = lhOff + 30 + lhFnLen + lhExLen;
        const compData = bytes.slice(dataStart, dataStart + txtEntry.compSize);
        let textBytes;
        if (txtEntry.compression === 0) {
            textBytes = compData;
        } else if (txtEntry.compression === 8) {
            if (!globalThis.DecompressionStream) {
                throw new Error("Browser lacks DecompressionStream. Use Chrome 80+ or Safari 16.4+.");
            }
            const ds = new DecompressionStream("deflate-raw");
            const writer = ds.writable.getWriter();
            await writer.write(compData);
            await writer.close();
            const reader = ds.readable.getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            const out = new Uint8Array(txtEntry.uncompSize || chunks.reduce((s, c) => s + c.length, 0));
            let pos = 0;
            for (const c of chunks) { out.set(c, pos); pos += c.length; }
            textBytes = out;
        } else {
            throw new Error(`Unsupported compression method ${txtEntry.compression}.`);
        }
        return decodeExportBytes(textBytes);
    }

    let best = null;
    for (const entry of ranked) {
        const text = await extractEntry(entry);
        const msgs = parseTxt(text);
        if (!best || msgs.length > best.msgs.length) {
            best = { text, name: entry.name, msgs };
        }
    }
    return best;
}

async function parseZip(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
        const { unzipSync } = await loadFflate();
        const best = pickBestZipTxt(unzipSync(bytes));
        if (!best.msgs.length) {
            const preview = best.text.slice(0, 300).replace(/\n/g, " ↵ ");
            throw new Error(`ZIP has "${best.name}" but no messages parsed. Preview: "${preview}"`);
        }
        return best;
    } catch (e) {
        const msg = e?.message || "";
        if (msg.includes("No .txt") || msg.includes("no messages parsed")) throw e;
        const best = await parseZipNative(buf);
        if (!best.msgs.length) {
            const preview = best.text.slice(0, 300).replace(/\n/g, " ↵ ");
            throw new Error(`ZIP has "${best.name}" but no messages parsed. Preview: "${preview}"`);
        }
        return best;
    }
}

const DATE_TIME_GAP = String.raw`(?:,\s*|\s+at\s+|\s+às\s+|\s+à\s+|\s*[-–\u2013\u2014\u2212]\s*|\s+)`;
const TIME_CORE = String.raw`\d{1,2}(?:[:.])\d{2}(?:(?:[:.])\d{2})?(?:\s*(?:[APap]\.?[Mm]\.?|(?<=[0-9])(?:[APap][Mm])))?`;

function parseTxt(text) {
    let body = String(text || "");
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

    const patterns = [
        new RegExp(String.raw`^(\d{4}[/.-]\d{1,2}[/.-]\d{1,2})${DATE_TIME_GAP}(${TIME_CORE})\]?\s*(?:[-–\u2013\u2014\u2212]\s*)?(.+?):\s(.*)$`, "iu"),
        new RegExp(String.raw`^\[?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})${DATE_TIME_GAP}(${TIME_CORE})\]?\s*(?:[-–\u2013\u2014\u2212]\s*)?(.+?):\s(.*)$`, "iu"),
        /^(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\s+-\s+([^:]+):\s+(.+)$/,
        /^\[(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\]\s+([^:]+):\s+(.+)$/,
    ];

    const msgs = [];
    let cur = null;
    const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (const rawLine of lines) {
        const clean = rawLine
            .replace(/\u200e|\u200f/g, "")
            .replace(/\u00a0/g, " ")
            .replace(/\u202f/g, " ")
            .replace(/[\u202a-\u202e]/g, "")
            .trim();
        if (!clean) continue;
        let matched = false;
        for (const re of patterns) {
            const m = clean.match(re);
            if (m) {
                if (cur) msgs.push(cur);
                cur = { date: m[1], time: m[2], sender: m[3].trim(), text: (m[4] || "").trim() };
                matched = true;
                break;
            }
        }
        if (!matched && cur) cur.text += "\n" + rawLine;
    }
    if (cur) msgs.push(cur);
    const SKIP = ["<Media omitted>", "image omitted", "video omitted", "audio omitted", "sticker omitted", "This message was deleted", "Messages and calls are end-to-end", "null", "You deleted this message"];
    return msgs.filter(m => m.text && m.text.length > 2 && !SKIP.some(s => m.text.includes(s)));
}

async function parseDB(buf, onStatus) {
    onStatus("Loading SQLite WASM…");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js");
    const SQL = await window.initSqlJs({ locateFile: () => "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm" });
    onStatus("Parsing msgstore.db…");
    const db = new SQL.Database(new Uint8Array(buf));
    const queries = [
        `SELECT m.timestamp, m.data as text, c.raw_string_jid as sender FROM message m LEFT JOIN jid c ON m.sender_jid_row_id=c._id WHERE m.data IS NOT NULL AND m.data!='' ORDER BY m.timestamp ASC LIMIT 8000`,
        `SELECT timestamp, body as text, key_remote_jid as sender FROM messages WHERE body IS NOT NULL AND body!='' ORDER BY timestamp ASC LIMIT 8000`,
    ];
    let rows = [];
    for (const q of queries) {
        try { const r = db.exec(q); if (r.length && r[0].values.length) { const cols = r[0].columns; rows = r[0].values.map(row => { const o = {}; cols.forEach((c, i) => o[c] = row[i]); return o; }); break; } } catch { }
    }
    db.close();
    return rows.map(r => ({
        date: r.timestamp ? new Date(r.timestamp * (r.timestamp > 1e12 ? 1 : 1000)).toLocaleDateString("en-IN") : "?",
        time: r.timestamp ? new Date(r.timestamp * (r.timestamp > 1e12 ? 1 : 1000)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "",
        sender: (r.sender || "Unknown").replace(/@.*/, ""), text: (r.text || "").trim(),
    })).filter(m => m.text && m.text.length > 2);
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 1 — BM25 (pure JS, zero deps, runs instantly in-browser)
// BM25 is what Elasticsearch/Lucene use as their core scorer.
// Much better than naive keyword matching — handles term frequency
// saturation and document length normalization.
// ═══════════════════════════════════════════════════════════════════
let bm25Index = null;

const STOPWORDS = new Set(["a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of", "and", "or", "but", "i", "my", "you", "your", "we", "he", "she", "they", "me", "him", "her", "us", "them", "this", "that", "was", "are", "be", "been", "has", "have", "had", "do", "did", "not", "no", "so", "if", "as", "by", "with", "from", "up", "out", "its", "also", "just", "about", "what", "when", "where", "who", "how", "all", "any", "some", "can", "will", "would", "could", "should", "may", "might", "yes", "ok", "okay", "hi", "hey", "yeah", "yep", "nope", "thanks", "thank", "please", "sorry", "oh", "ah", "hm", "lol", "haha", "hehe"]);

function tokenize(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function buildBM25Index(messages) {
    const k1 = 1.5, b = 0.75;
    const N = messages.length;
    const docs = messages.map(m => tokenize(`${m.sender} ${m.text}`));
    const avgLen = docs.reduce((s, d) => s + d.length, 0) / N;

    // Build IDF map
    const df = {};
    for (const doc of docs) {
        for (const t of new Set(doc)) df[t] = (df[t] || 0) + 1;
    }
    const idf = {};
    for (const [t, freq] of Object.entries(df)) {
        idf[t] = Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
    }

    return { docs, idf, avgLen, k1, b, N };
}

function bm25Score(index, queryTokens, docIdx) {
    const { docs, idf, avgLen, k1, b } = index;
    const doc = docs[docIdx];
    const docLen = doc.length;
    let score = 0;
    const tf = {};
    for (const t of doc) tf[t] = (tf[t] || 0) + 1;
    for (const qt of queryTokens) {
        if (!(qt in idf)) continue;
        const f = tf[qt] || 0;
        const num = f * (k1 + 1);
        const den = f + k1 * (1 - b + b * docLen / avgLen);
        score += idf[qt] * num / den;
    }
    return score;
}

function stage1BM25(query, messages, onStatus) {
    onStatus("Stage 1: BM25 filtering…");
    if (!bm25Index || bm25Index.N !== messages.length) {
        bm25Index = buildBM25Index(messages);
    }
    const qTokens = tokenize(query);
    const scored = messages.map((msg, i) => ({
        msg,
        embedScore: bm25Score(bm25Index, qTokens, i),
    }));
    const max = Math.max(...scored.map(s => s.embedScore), 1);
    // Normalize 0-1
    scored.forEach(s => s.embedScore = s.embedScore / max);
    return scored.sort((a, b) => b.embedScore - a.embedScore).slice(0, 25);
}

// ═══════════════════════════════════════════════════════════════════
// STAGE 2 — Claude API reranker (semantic LLM scoring)
// Receives 25 BM25 candidates, returns top 10 with reasoning
// ═══════════════════════════════════════════════════════════════════
function applyRerankScores(candidates, scores) {
    try {
        const parsed = typeof scores === "string"
            ? JSON.parse(scores.replace(/```json|```/g, "").trim())
            : scores;
        if (!Array.isArray(parsed)) throw new Error("not array");
        return parsed
            .map(({ index, score, reason }) => candidates[index]
                ? { ...candidates[index], llmScore: Number(score), reason }
                : null)
            .filter(Boolean)
            .sort((a, b) => b.llmScore - a.llmScore)
            .slice(0, 10)
            .filter(r => r.llmScore > 0.15);
    } catch {
        return candidates.slice(0, 10).map(c => ({ ...c, llmScore: c.embedScore, reason: "BM25 score (rerank parse error)" }));
    }
}

function stage2Bm25Only(candidates, onStatus) {
    onStatus("Stage 2: BM25 ranking…");
    return candidates
        .slice(0, 10)
        .filter(c => c.embedScore > 0.01)
        .map(c => ({ ...c, llmScore: c.embedScore, reason: "BM25 relevance" }));
}

const RERANK_SERVER_BASES = ["http://localhost:3000", "http://127.0.0.1:3000"];

async function stage2Claude(query, candidates, onStatus) {
    onStatus("Stage 2: LLM semantic reranking…");
    const payload = {
        query,
        candidates: candidates.map(c => ({ sender: c.msg.sender, text: c.msg.text })),
    };
    let lastErr;
    for (const base of RERANK_SERVER_BASES) {
        try {
            const res = await fetch(`${base}/api/wa-search/rerank`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || res.statusText || "Rerank request failed");
            return applyRerankScores(candidates, data.scores ?? data.raw);
        } catch (e) {
            lastErr = e;
        }
    }
    const msg = lastErr?.message || "unknown error";
    if (msg === "Failed to fetch") {
        throw new Error("LLM rerank needs the local app running (npm start → :3000) with an API key in Settings.");
    }
    throw new Error(msg);
}

async function runStage2(reranker, query, candidates, onStatus) {
    if (reranker === "claude") return stage2Claude(query, candidates, onStatus);
    if (reranker === "webllm") {
        onStatus("Stage 2: on-device LLM not loaded — using BM25…");
        return stage2Bm25Only(candidates, onStatus);
    }
    return stage2Bm25Only(candidates, onStatus);
}

// ═══════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════
const DEMO_TXT = `01/03/2024, 10:22 - Priya: Hey! Did you book the Goa tickets yet?
01/03/2024, 10:25 - Rahul: Not yet, checking flights. IndiGo has a sale till tonight
01/03/2024, 10:26 - Priya: Don't miss it please! Last time you forgot and prices doubled 😅
01/03/2024, 10:30 - Rahul: Okay okay booked! Departure March 15th, return 20th
01/03/2024, 10:31 - Priya: Yay!! Which hotel are you thinking?
01/03/2024, 10:33 - Rahul: Taj or that boutique place near Baga beach, haven't decided
01/03/2024, 10:35 - Priya: The boutique one sounds nicer and more private
02/03/2024, 09:14 - Rahul: Mom called. She wants us to come home for Holi this year
02/03/2024, 09:21 - Priya: When is Holi exactly?
02/03/2024, 09:22 - Rahul: March 25th. That's after Goa so should be fine
03/03/2024, 18:45 - Priya: Have you seen my blue jacket? Can't find it anywhere
03/03/2024, 18:50 - Rahul: I think it's in the car, left it there after last week's dinner
04/03/2024, 12:00 - Rahul: Quick reminder - rent is due this Friday
04/03/2024, 12:05 - Priya: Already transferred my half. Did you get it?
04/03/2024, 14:30 - Priya: I've been feeling so tired lately, need to get blood work done
04/03/2024, 14:35 - Rahul: Please do it soon. Low iron maybe? You haven't been sleeping well either
04/03/2024, 14:36 - Priya: Probably. Booking an appointment at Fortis tomorrow
05/03/2024, 20:10 - Rahul: What do you want for dinner?
05/03/2024, 20:12 - Priya: Too tired to cook. Shall we order from Swiggy?
05/03/2024, 20:13 - Rahul: Sure, biryani from Behrouz?
05/03/2024, 20:14 - Priya: Yes please! Extra raita
06/03/2024, 11:00 - Priya: My boss is being impossible again. Third time this week he changed the brief
06/03/2024, 11:05 - Rahul: That sounds exhausting. Do you want to talk about it tonight?
06/03/2024, 11:07 - Rahul: I think that's a smart move. You've been unhappy there for months
07/03/2024, 09:30 - Rahul: Happy birthday to your dad! Did you call him?
07/03/2024, 09:35 - Priya: Yes! He was so happy. We're having a small dinner on Sunday
07/03/2024, 09:37 - Rahul: I'll get him a bottle, maybe something he actually likes`;

// ═══════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════
const PALETTE = ["#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF", "#C77DFF", "#FF9A3C"];
function senderColor(n) { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) & 0xffff; return PALETTE[h % PALETTE.length]; }

function PipelineDiagram({ stage, reranker }) {
    const steps = [
        { id: "s1", label: "MiniLM Embed", sub: "~23MB · WebAssembly", active: stage === "embed" },
        {
            id: "s2", label: reranker === "webllm" ? "Qwen2.5-0.5B" : reranker === "claude" ? "Claude Sonnet" : "Embed Only",
            sub: reranker === "webllm" ? "~400MB · WebGPU" : reranker === "claude" ? "API · Cloud" : "cosine similarity",
            active: stage === "rerank"
        },
        { id: "s3", label: "Ranked Results", sub: "top 10 by LLM score", active: stage === "done" },
    ];
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 20, overflowX: "auto", paddingBottom: 4 }}>
            {steps.map((s, i) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
                    <div style={{
                        padding: "8px 12px", borderRadius: 10, textAlign: "center", minWidth: 90,
                        background: s.active ? "#1a2a1a" : "#0c120c",
                        border: `1px solid ${s.active ? "#4ade80" : "#1a2a1a"}`,
                        transition: "all 0.3s",
                    }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: s.active ? "#4ade80" : "#2a4030", letterSpacing: "0.05em" }}>{s.label}</div>
                        <div style={{ fontSize: 8, color: s.active ? "#2a5030" : "#1a2a1a", marginTop: 2 }}>{s.sub}</div>
                    </div>
                    {i < steps.length - 1 && (
                        <div style={{ width: 24, height: 1, background: "#1a2a1a", position: "relative", flexShrink: 0 }}>
                            <div style={{
                                position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
                                borderLeft: "6px solid #1a2a1a", borderTop: "4px solid transparent", borderBottom: "4px solid transparent",
                            }} />
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function RerankerPicker({ value, onChange, webgpu, llmReady }) {
    const opts = [
        {
            id: "webllm", label: "Qwen (On-Device)", icon: "📱", color: "#4ade80",
            desc: webgpu ? "WebGPU available ✓" : "WebGPU not detected — may be slow"
        },
        { id: "claude", label: "LLM Rerank", icon: "☁️", color: "#60a5fa", desc: "npm start :3000 + API key in Settings" },
        { id: "embed", label: "Embed Only", icon: "⚡", color: "#fbbf24", desc: "Fastest · No LLM rerank" },
    ];
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {opts.map(o => (
                <button key={o.id} onClick={() => onChange(o.id)} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                    background: value === o.id ? o.color + "12" : "#0c120c",
                    border: `1px solid ${value === o.id ? o.color + "60" : "#1a2a1a"}`,
                    borderRadius: 10, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                    transition: "all 0.15s",
                }}>
                    <span style={{ fontSize: 18 }}>{o.icon}</span>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: value === o.id ? o.color : "#3a5040", letterSpacing: "0.04em" }}>
                            {o.label}
                            {o.id === "webllm" && llmReady && <span style={{ marginLeft: 6, fontSize: 9, color: "#4ade80" }}>● LOADED</span>}
                        </div>
                        <div style={{ fontSize: 9, color: "#1a3020", marginTop: 2 }}>{o.desc}</div>
                    </div>
                    <div style={{
                        width: 14, height: 14, borderRadius: "50%",
                        border: `2px solid ${value === o.id ? o.color : "#1a2a1a"}`,
                        background: value === o.id ? o.color : "transparent",
                        transition: "all 0.15s", flexShrink: 0,
                    }} />
                </button>
            ))}
        </div>
    );
}

function ResultCard({ r, i }) {
    const c = senderColor(r.msg.sender);
    const score = r.llmScore ?? r.embedScore;
    const pct = Math.round(score * 100);
    return (
        <div style={{
            background: "#0c120c", border: "1px solid #1a2a1a", borderLeft: `3px solid ${c}`,
            borderRadius: 12, padding: "14px 16px",
            animation: `fu 0.35s ease ${i * 60}ms both`,
        }}>
            <style>{`@keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: c }}>{r.msg.sender}</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {/* Score bar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <div style={{ width: 40, height: 3, background: "#1a2a1a", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: c, borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 10, color: c, fontWeight: 700 }}>{pct}%</span>
                    </div>
                    <span style={{ fontSize: 9, color: "#1a2a1a" }}>{r.msg.date}</span>
                </div>
            </div>
            <div style={{ fontSize: 13, color: "#9ab89a", lineHeight: 1.65, marginBottom: r.reason ? 8 : 0 }}>{r.msg.text}</div>
            {r.reason && (
                <div style={{ fontSize: 9, color: "#2a4030", borderTop: "1px solid #1a2a1a", paddingTop: 6, marginTop: 6 }}>
                    ↳ {r.reason}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
    const [messages, setMessages] = useState([]);
    const [chatName, setChatName] = useState("");
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [stage, setStage] = useState("idle"); // idle | bm25 | rerank | done
    const [status, setStatus] = useState("");
    const [fileLoading, setFileLoading] = useState(false);
    const [fileStatus, setFileStatus] = useState("");
    const [searched, setSearched] = useState(false);
    const [error, setError] = useState("");
    const [showSettings, setShowSettings] = useState(false);
    const [reranker, setReranker] = useState("embed");
    const [webgpu, setWebgpu] = useState(false);
    const [llmReady, setLlmReady] = useState(false);
    const fileRef = useRef();

    useEffect(() => {
        setWebgpu(typeof navigator !== "undefined" && "gpu" in navigator);
    }, []);

    const handleFile = useCallback(async (file) => {
        if (!file) return;
        setFileLoading(true); setError(""); setResults([]); setSearched(false);
        bm25Index = null;
        try {
            let msgs, name;
            if (file.name.endsWith(".zip")) {
                setFileStatus("Reading ZIP file…");
                const buf = await file.arrayBuffer();
                setFileStatus("Extracting ZIP contents…");
                const z = await parseZip(buf);
                setFileStatus(`Parsing chat: ${z.name}…`);
                msgs = z.msgs;
                name = z.name.replace(/\.txt$/i, "").replace(/^_chat$/i, "Chat").replace(/_/g, " ");
                if (!msgs.length) {
                    const preview = z.text.slice(0, 300).replace(/\n/g, " ↵ ");
                    throw new Error(`ZIP extracted OK (${z.name}) but no messages parsed. Text preview: "${preview}"`);
                }
            } else if (file.name.endsWith(".txt")) {
                setFileStatus("Reading file…");
                const text = decodeExportBytes(new Uint8Array(await file.arrayBuffer()));
                msgs = parseTxt(text);
                name = file.name.replace(".txt", "").replace(/_/g, " ");
                if (!msgs.length) {
                    const preview = text.slice(0, 300).replace(/\n/g, " ↵ ");
                    throw new Error(`No messages parsed from TXT. Preview: "${preview}"`);
                }
            } else if (file.name.endsWith(".db")) {
                msgs = await parseDB(await file.arrayBuffer(), setFileStatus);
                name = "msgstore.db";
                if (!msgs.length) throw new Error("No messages found in DB. Schema may differ from expected.");
            } else {
                throw new Error("Unsupported file type. Upload a .zip, .txt, or .db file.");
            }
            setMessages(msgs); setChatName(name);
        } catch (e) { setError(e.message); }
        setFileStatus(""); setFileLoading(false);
    }, []);

    const loadDemo = () => {
        const msgs = parseTxt(DEMO_TXT);
        setMessages(msgs); setChatName("Priya & Rahul · Demo");
        setResults([]); setSearched(false); setError(""); bm25Index = null;
    };

    const handleSearch = async () => {
        if (!query.trim() || !messages.length || stage !== "idle") return;
        setSearched(true); setResults([]); setError("");
        try {
            setStage("bm25");
            const candidates = stage1BM25(query, messages, setStatus);
            setStage("rerank");
            const final = await runStage2(reranker, query, candidates, setStatus);
            setResults(final);
        } catch (e) { setError("Search failed: " + e.message); }
        setStage("done"); setStatus("");
        setTimeout(() => setStage("idle"), 800);
    };

    const SUGGESTIONS = ["travel plans", "money or rent", "health issues", "work stress", "food orders", "birthday", "argument or fight", "weekend plans"];
    const isSearching = stage === "bm25" || stage === "rerank";

    return (
        <div style={{
            minHeight: "100vh", background: "#080d08",
            color: "#b8d4b8", fontFamily: "'IBM Plex Mono','Courier New',monospace",
            display: "flex", flexDirection: "column", alignItems: "center",
        }}>
            {/* Scanline overlay */}
            <div style={{
                position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
                background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,80,0.012) 2px, rgba(0,255,80,0.012) 4px)",
            }} />

            {/* Header */}
            <div style={{
                width: "100%", boxSizing: "border-box", zIndex: 1, position: "relative",
                background: "#080d08", borderBottom: "1px solid #1a2a1a",
                padding: "16px 20px", display: "flex", alignItems: "center", gap: 12,
            }}>
                <div style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: "linear-gradient(135deg,#25D366,#076636)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 18, boxShadow: "0 0 16px #25D36628",
                }}>💬</div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#4ade80", letterSpacing: "0.05em" }}>WA Semantic Search <span style={{ fontSize: 9, color: "#1a3020", fontWeight: 400 }}>v4</span></div>
                    <div style={{ fontSize: 9, color: "#1a3020", marginTop: 1, letterSpacing: "0.08em" }}>
                        2-STAGE PIPELINE · EMBED → LLM RERANK · PRIVATE
                    </div>
                </div>
                {messages.length > 0 && (
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setShowSettings(s => !s)} style={{
                            background: showSettings ? "#1a2a1a" : "transparent",
                            border: "1px solid #1a2a1a", borderRadius: 8, padding: "5px 10px",
                            color: showSettings ? "#4ade80" : "#2a4030", fontFamily: "inherit", fontSize: 10, cursor: "pointer",
                        }}>⚙ Engine</button>
                        <button onClick={() => { setMessages([]); setResults([]); setSearched(false); setQuery(""); bm25Index = null; setShowSettings(false); }} style={{
                            background: "transparent", border: "1px solid #1a2a1a", borderRadius: 8, padding: "5px 10px",
                            color: "#2a4030", fontFamily: "inherit", fontSize: 10, cursor: "pointer",
                        }}>← Reset</button>
                    </div>
                )}
            </div>

            <div style={{ width: "100%", maxWidth: 680, padding: "24px 16px 80px", boxSizing: "border-box", position: "relative", zIndex: 1 }}>

                {/* ── UPLOAD SCREEN ── */}
                {!messages.length ? (
                    <div>
                        <div style={{ textAlign: "center", marginBottom: 32 }}>
                            <div style={{ fontSize: 24, fontWeight: 800, color: "#e8f5e0", letterSpacing: "-0.02em", lineHeight: 1.25, marginBottom: 10 }}>
                                Search by <span style={{ color: "#4ade80" }}>meaning</span>,<br />not keywords.
                            </div>
                            <div style={{ fontSize: 11, color: "#2a4030", lineHeight: 1.8 }}>
                                Two-stage AI pipeline: fast embedding filter → LLM reranking.<br />
                                Ask <em style={{ color: "#3a6040" }}>"when did we argue about money"</em> and it finds it.
                            </div>
                        </div>

                        {/* Pipeline visual on landing */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0, marginBottom: 28, overflowX: "auto" }}>
                            {[
                                { label: "Your Chat", icon: "💬", color: "#2a4030" },
                                { label: "MiniLM Embed", icon: "🧮", color: "#4ade80", sub: "stage 1" },
                                { label: "Qwen / Claude", icon: "🧠", color: "#60a5fa", sub: "stage 2 rerank" },
                                { label: "Results", icon: "✨", color: "#fbbf24" },
                            ].map((s, i, arr) => (
                                <div key={i} style={{ display: "flex", alignItems: "center" }}>
                                    <div style={{ textAlign: "center", padding: "8px 10px" }}>
                                        <div style={{ fontSize: 18, marginBottom: 3 }}>{s.icon}</div>
                                        <div style={{ fontSize: 9, color: s.color, fontWeight: 700, letterSpacing: "0.06em" }}>{s.label}</div>
                                        {s.sub && <div style={{ fontSize: 8, color: "#1a2a1a", marginTop: 1 }}>{s.sub}</div>}
                                    </div>
                                    {i < arr.length - 1 && <div style={{ color: "#1a2a1a", fontSize: 12, padding: "0 2px" }}>→</div>}
                                </div>
                            ))}
                        </div>

                        {/* Drop zones */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                            {[
                                {
                                    id: "zip", label: "WhatsApp ZIP / TXT", icon: "📦", color: "#4ade80", accept: ".zip,.txt",
                                    how: "Chat → ⋮ → More → Export chat"
                                },
                                {
                                    id: "db", label: "msgstore.db", icon: "🗄️", color: "#FFD93D", accept: ".db",
                                    how: "ADB backup · Android only"
                                },
                            ].map(z => (
                                <div key={z.id}
                                    onClick={() => { fileRef.current.accept = z.accept; fileRef.current.click(); }}
                                    style={{
                                        border: `1px dashed #1a2a1a`, borderRadius: 14, padding: "20px 14px",
                                        textAlign: "center", cursor: "pointer", background: "#0c120c",
                                        transition: "all 0.2s",
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.borderColor = z.color + "60"}
                                    onMouseLeave={e => e.currentTarget.style.borderColor = "#1a2a1a"}
                                >
                                    <div style={{ fontSize: 24, marginBottom: 8 }}>{z.icon}</div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: z.color, marginBottom: 5 }}>{z.label}</div>
                                    <div style={{ fontSize: 9, color: "#1a2a1a", lineHeight: 1.6 }}>{z.how}</div>
                                </div>
                            ))}
                        </div>
                        <input ref={fileRef} type="file" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} style={{ display: "none" }} />

                        {fileLoading && (
                            <div style={{ padding: "14px", background: "#0c120c", border: "1px solid #1a2a1a", borderRadius: 10, textAlign: "center", marginBottom: 12 }}>
                                <div style={{ fontSize: 10, color: "#2a4030", letterSpacing: "0.06em" }}>{fileStatus || "Processing…"}</div>
                            </div>
                        )}

                        <button onClick={loadDemo} style={{
                            width: "100%", background: "transparent", border: "1px solid #1a2a1a",
                            borderRadius: 12, padding: "12px", color: "#2a4030", fontFamily: "inherit",
                            fontSize: 11, cursor: "pointer", transition: "all 0.2s", letterSpacing: "0.04em",
                        }}
                            onMouseEnter={e => { e.target.style.color = "#4ade80"; e.target.style.borderColor = "#4ade80"; }}
                            onMouseLeave={e => { e.target.style.color = "#2a4030"; e.target.style.borderColor = "#1a2a1a"; }}
                        >
                            Try with demo chat →
                        </button>

                        {error && <div style={{ marginTop: 12, padding: "12px 14px", background: "#120c0c", border: "1px solid #2a1a1a", borderRadius: 10, fontSize: 11, color: "#e07070" }}>⚠ {error}</div>}
                    </div>

                ) : (
                    <>
                        {/* Chat info */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
                            <div>
                                <div style={{ fontSize: 12, color: "#4ade80", fontWeight: 700 }}>{chatName}</div>
                                <div style={{ fontSize: 9, color: "#1a3020", marginTop: 2 }}>{messages.length.toLocaleString()} messages</div>
                            </div>
                            <div style={{
                                fontSize: 9, padding: "3px 10px", borderRadius: 20,
                                background: "#1a2a1a", color: "#2a5030", letterSpacing: "0.06em",
                            }}>
                                {reranker === "webllm" ? "📱 ON-DEVICE LLM" : reranker === "claude" ? "☁️ CLAUDE RERANK" : "⚡ EMBED ONLY"}
                            </div>
                        </div>

                        {/* Settings panel */}
                        {showSettings && (
                            <div style={{ background: "#0c120c", border: "1px solid #1a2a1a", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                                <div style={{ fontSize: 10, color: "#2a5030", letterSpacing: "0.08em", marginBottom: 12 }}>RERANKER ENGINE</div>
                                <RerankerPicker value={reranker} onChange={r => { setReranker(r); setShowSettings(false); }} webgpu={webgpu} llmReady={llmReady} />
                                <div style={{ marginTop: 10, fontSize: 9, color: "#1a2a1a", lineHeight: 1.7 }}>
                                    Stage 1 always uses MiniLM embeddings to filter to 25 candidates.<br />
                                    Stage 2 reranks those 25 with an LLM for precision.
                                </div>
                            </div>
                        )}

                        {/* Pipeline diagram */}
                        <PipelineDiagram stage={stage} reranker={reranker} />

                        {/* Search bar */}
                        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                            <input
                                value={query} onChange={e => setQuery(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && handleSearch()}
                                placeholder={`"when did we argue" · "travel booking" · "health issues"`}
                                style={{
                                    flex: 1, background: "#0c120c", border: "1px solid #1a2a1a",
                                    borderRadius: 11, padding: "13px 14px", color: "#b8d4b8",
                                    fontFamily: "inherit", fontSize: 12, outline: "none",
                                }}
                                onFocus={e => e.target.style.borderColor = "#4ade8040"}
                                onBlur={e => e.target.style.borderColor = "#1a2a1a"}
                            />
                            <button onClick={handleSearch} disabled={isSearching || !query.trim()} style={{
                                background: isSearching ? "#0c120c" : "linear-gradient(135deg,#25D366,#076636)",
                                border: "none", borderRadius: 11, padding: "0 18px",
                                color: "#fff", fontFamily: "inherit", fontSize: 12, fontWeight: 700,
                                cursor: isSearching ? "not-allowed" : "pointer", minWidth: 72,
                                transition: "all 0.2s", boxShadow: isSearching ? "none" : "0 4px 16px #25D36630",
                            }}>
                                {isSearching ? "…" : "Search"}
                            </button>
                        </div>

                        {/* Status */}
                        {isSearching && (
                            <div style={{ marginBottom: 16, padding: "12px 14px", background: "#0c120c", border: "1px solid #1a2a1a", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={{ width: 16, height: 16, flexShrink: 0, borderRadius: "50%", border: "2px solid #1a2a1a", borderTopColor: "#4ade80", animation: "spin 0.8s linear infinite" }} />
                                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
                                <div style={{ fontSize: 10, color: "#2a4030", letterSpacing: "0.05em" }}>{status}</div>
                            </div>
                        )}

                        {/* Suggestions */}
                        {!searched && (
                            <div style={{ marginBottom: 20 }}>
                                <div style={{ fontSize: 9, color: "#1a2a1a", letterSpacing: "0.1em", marginBottom: 10 }}>EXAMPLE QUERIES</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                    {SUGGESTIONS.map(s => (
                                        <button key={s} onClick={() => setQuery(s)} style={{
                                            background: "#0c120c", border: "1px solid #1a2a1a", borderRadius: 20,
                                            padding: "6px 12px", color: "#2a4030", fontFamily: "inherit", fontSize: 10, cursor: "pointer",
                                            transition: "all 0.15s",
                                        }}
                                            onMouseEnter={e => { e.target.style.borderColor = "#4ade8040"; e.target.style.color = "#4ade80"; }}
                                            onMouseLeave={e => { e.target.style.borderColor = "#1a2a1a"; e.target.style.color = "#2a4030"; }}
                                        >{s}</button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {error && <div style={{ padding: "12px 14px", background: "#120c0c", border: "1px solid #2a1a1a", borderRadius: 10, fontSize: 11, color: "#e07070", marginBottom: 14 }}>⚠ {error}</div>}

                        {!isSearching && searched && !results.length && !error && (
                            <div style={{ textAlign: "center", padding: "48px 0", color: "#1a2a1a" }}>
                                <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
                                <div style={{ fontSize: 12 }}>No relevant messages found. Try rephrasing.</div>
                            </div>
                        )}

                        {!isSearching && results.length > 0 && (
                            <div>
                                <div style={{ fontSize: 9, color: "#1a2a1a", letterSpacing: "0.1em", marginBottom: 12 }}>
                                    {results.length} RESULTS · {reranker === "webllm" ? "ON-DEVICE LLM RERANKED" : reranker === "claude" ? "CLAUDE RERANKED" : "EMBEDDING SCORED"}
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {results.map((r, i) => <ResultCard key={i} r={r} i={i} />)}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
