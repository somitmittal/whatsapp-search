import os from 'os';
import { execSync } from 'child_process';

/**
 * Max share of *available* RAM given to Ollama. The rest stays for macOS, Electron, and apps
 * so the machine does not swap or hang when the model loads.
 */
export const RAM_BUDGET_RATIO = 0.6;

/**
 * Tiered models. `minBudgetGb` = RAM headroom needed at runtime (weights + KV cache + batch).
 * Picks the largest tier that fits inside the computed budget only.
 */
export const MODEL_TIERS = [
  {
    model: 'gemma2:9b',
    sizeGb: 5.4,
    minBudgetGb: 10,
    label: 'Best quality',
    reason: 'Fits your memory budget with room to spare — best search and summary quality.',
  },
  {
    model: 'qwen3.5:4b',
    sizeGb: 2.7,
    minBudgetGb: 6.5,
    label: 'Balanced',
    reason: 'Balanced speed and quality without overloading available memory.',
  },
  {
    model: 'llama3.2:3b',
    sizeGb: 2.0,
    minBudgetGb: 5,
    label: 'Recommended',
    reason: 'Comfortable for chat search — fast and unlikely to pressure the system.',
  },
  {
    model: 'phi3:mini',
    sizeGb: 2.3,
    minBudgetGb: 3.5,
    label: 'Lightweight',
    reason: 'Keeps the Mac responsive when free memory is tight.',
  },
  {
    model: 'llama3.2:1b',
    sizeGb: 1.3,
    minBudgetGb: 0,
    label: 'Minimal',
    reason: 'Safest option under memory pressure — basic quality but avoids hangs.',
  },
];

function roundGb(n) {
  return Math.round(n * 10) / 10;
}

export function getMacAvailableRamGb() {
  try {
    const pageSize = parseInt(execSync('sysctl -n hw.pagesize', { encoding: 'utf8', timeout: 3000 }).trim(), 10) || 4096;
    const vm = execSync('vm_stat', { encoding: 'utf8', timeout: 3000 });
    const pages = (label) => {
      const m = vm.match(new RegExp(`${label}:\\s*(\\d+)`, 'i'));
      return m ? parseInt(m[1], 10) : 0;
    };
    const availablePages = pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable');
    return roundGb((availablePages * pageSize) / (1024 ** 3));
  } catch {
    return null;
  }
}

export function getLinuxAvailableRamGb() {
  try {
    const meminfo = execSync('grep -E "^(MemAvailable|MemFree):" /proc/meminfo', { encoding: 'utf8', timeout: 3000 });
    const avail = meminfo.match(/MemAvailable:\s*(\d+)\s*kB/i);
    if (avail) return roundGb(parseInt(avail[1], 10) / (1024 ** 2));
    const free = meminfo.match(/MemFree:\s*(\d+)\s*kB/i);
    if (free) return roundGb(parseInt(free[1], 10) / (1024 ** 2));
  } catch { /* ignore */ }
  return null;
}

/** @returns {'normal' | 'warn' | 'critical'} */
export function getMemoryPressureLevel() {
  if (process.platform !== 'darwin') return 'normal';
  try {
    const out = execSync('memory_pressure 2>/dev/null', { encoding: 'utf8', timeout: 2500 });
    if (/critical|policy:\s*1[0-9]\./i.test(out)) return 'critical';
    if (/warn|policy:\s*[2-4][0-9]\./i.test(out)) return 'warn';
    const pct = out.match(/memory free percentage:\s*(\d+)%/i)?.[1];
    if (pct != null) {
      const n = parseInt(pct, 10);
      if (n < 15) return 'critical';
      if (n < 30) return 'warn';
    }
  } catch { /* ignore */ }
  return 'normal';
}

/**
 * @returns {number} GB
 */
export function getAvailableRamGb() {
  const totalGb = os.totalmem() / (1024 ** 3);

  if (process.platform === 'darwin') {
    const mac = getMacAvailableRamGb();
    if (mac != null && mac > 0.5) return mac;
  }
  if (process.platform === 'linux') {
    const linux = getLinuxAvailableRamGb();
    if (linux != null && linux > 0.5) return linux;
  }

  const freeGb = os.freemem() / (1024 ** 3);
  if (freeGb > 1) return roundGb(freeGb);

  // Conservative fallback — never assume full total RAM is free.
  return roundGb(totalGb * 0.5);
}

/**
 * RAM we allow Ollama to use. Never more than 60% of what is actually available.
 * @param {number} availableRamGb
 * @param {'normal' | 'warn' | 'critical'} [pressure]
 */
export function computeModelBudgetGb(availableRamGb, pressure = 'normal') {
  let budget = roundGb(Math.max(0, availableRamGb) * RAM_BUDGET_RATIO);
  if (pressure === 'warn') budget = roundGb(budget * 0.75);
  if (pressure === 'critical') budget = 0;
  return budget;
}

/** Lower context window on tight budgets — KV cache scales with num_ctx. */
export function numCtxForBudget(budgetGb) {
  if (budgetGb >= 10) return 4096;
  if (budgetGb >= 6) return 3072;
  if (budgetGb >= 4) return 2048;
  return 1536;
}

/**
 * @param {number} budgetGb
 * @param {typeof MODEL_TIERS} [tiers]
 */
export function pickModelTierForBudget(budgetGb, tiers = MODEL_TIERS) {
  return tiers.find((t) => budgetGb >= t.minBudgetGb) || tiers[tiers.length - 1];
}

export function tierForModel(modelName) {
  return MODEL_TIERS.find((t) => t.model === modelName) || null;
}

/**
 * Check a model against the RAM budget. Warns when over budget but keeps the requested model.
 * When no model is requested, returns the largest tier that fits the budget.
 * @param {string} [requestedModel]
 */
export function resolveSafeOllamaModel(requestedModel) {
  const availableRamGb = getAvailableRamGb();
  const pressure = getMemoryPressureLevel();
  const budgetGb = computeModelBudgetGb(availableRamGb, pressure);
  const safeTier = pickModelTierForBudget(budgetGb);

  const reqTier = requestedModel ? tierForModel(requestedModel) : null;
  const fits = reqTier && budgetGb >= reqTier.minBudgetGb;
  const numCtx = numCtxForBudget(budgetGb);

  let model;
  let warning = null;

  if (requestedModel) {
    model = requestedModel;
    if (pressure === 'critical') {
      warning = 'Memory pressure is high — this model may make your Mac less responsive.';
    } else if (!fits) {
      warning = `${requestedModel} needs more free RAM than the safe budget (~${budgetGb} GB). It may run slowly or cause memory pressure.`;
    }
  } else if (pressure === 'critical') {
    model = MODEL_TIERS[MODEL_TIERS.length - 1].model;
    warning = 'Memory pressure is high — defaulting to the smallest model for new setups.';
  } else {
    model = safeTier.model;
  }

  return {
    model,
    budgetGb,
    availableRamGb,
    pressure,
    numCtx,
    downgraded: false,
    exceedsBudget: !!requestedModel && !fits,
    suggestedModel: requestedModel && !fits ? safeTier.model : null,
    requestedModel: requestedModel || null,
    warning,
  };
}

function detectGpu() {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('system_profiler SPDisplaysDataType 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const chip = out.match(/Chip(?:set)? Model:\s*(.+)/i)?.[1]?.trim();
      const vram = out.match(/VRAM.*?:\s*(\d+)/i)?.[1];
      if (chip) return { name: chip, vramGb: vram ? parseInt(vram, 10) / 1024 : null, type: 'apple' };
    }
    if (process.platform === 'linux') {
      try {
        const nv = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
        const [name, memMb] = nv.trim().split(',').map((s) => s.trim());
        if (name) return { name, vramGb: memMb ? Math.round(parseInt(memMb, 10) / 1024) : null, type: 'nvidia' };
      } catch { /* no nvidia */ }
    }
  } catch { /* silent */ }
  return null;
}

function buildReason(tier, availableRamGb, budgetGb, pressure) {
  const avail = roundGb(availableRamGb);
  const budget = roundGb(budgetGb);
  const pct = Math.round(RAM_BUDGET_RATIO * 100);
  const headroom = 100 - pct;
  let base = `${tier.reason} Using ~${budget} GB of ~${avail} GB available (${pct}% cap — ~${headroom}% left for macOS and apps).`;
  if (pressure === 'warn') base += ' Memory is tight; recommendation adjusted down.';
  if (pressure === 'critical') base += ' Memory pressure is critical; using minimal model.';
  return base;
}

export async function getHardwareRecommendation(ollamaProvider) {
  const totalRamGb = roundGb(os.totalmem() / (1024 ** 3));
  const freeRamGb = roundGb(os.freemem() / (1024 ** 3));
  const availableRamGb = getAvailableRamGb();
  const pressure = getMemoryPressureLevel();
  const budgetGb = computeModelBudgetGb(availableRamGb, pressure);
  const cpuCores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'Unknown';
  const gpu = detectGpu();

  const recommended = pickModelTierForBudget(budgetGb);
  const numCtx = numCtxForBudget(budgetGb);

  let localModels = [];
  let modelAvailable = false;
  try {
    if (ollamaProvider) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const baseUrl = ollamaProvider._baseUrl || 'http://localhost:11434';
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        localModels = (data.models || []).map((m) => m.name);
        modelAvailable = localModels.some(
          (m) => m === recommended.model || m === `${recommended.model}:latest` || m.startsWith(`${recommended.model}:`),
        );
      }
    }
  } catch { /* ollama not running */ }

  return {
    hardware: {
      ram: totalRamGb,
      availableRam: availableRamGb,
      budgetRam: budgetGb,
      budgetRatio: RAM_BUDGET_RATIO,
      memoryPressure: pressure,
      numCtx,
      freeRam: freeRamGb,
      cpuCores,
      cpuModel: cpuModel.replace(/\s+/g, ' ').trim(),
      gpu: gpu ? { name: gpu.name, vramGb: gpu.vramGb, type: gpu.type } : null,
      platform: process.platform,
      arch: process.arch,
    },
    recommended: {
      model: recommended.model,
      sizeGb: recommended.sizeGb,
      label: recommended.label,
      reason: buildReason(recommended, availableRamGb, budgetGb, pressure),
      available: modelAvailable,
      numCtx,
    },
    localModels,
    allTiers: MODEL_TIERS.map((t) => ({
      model: t.model,
      sizeGb: t.sizeGb,
      minBudgetGb: t.minBudgetGb,
      label: t.label,
      fits: budgetGb >= t.minBudgetGb,
    })),
  };
}

/** Apply memory-safe Ollama settings to env + DB. */
export function applyOllamaMemorySettings(db, safe) {
  process.env.OLLAMA_NUM_CTX = String(safe.numCtx);
  if (db?.setSetting) {
    db.setSetting('ollama_num_ctx', String(safe.numCtx));
  }
}
