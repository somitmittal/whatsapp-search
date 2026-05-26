import os from 'os';
import { execSync } from 'child_process';

/**
 * Tiered model recommendations based on system resources.
 * Each tier: { model, sizeGb, minRamGb, label, reason }
 * Order matters — first match wins (checked top-down by available RAM).
 */
const MODEL_TIERS = [
  {
    model: 'gemma2:9b',
    sizeGb: 5.4,
    minRamGb: 16,
    label: 'Best quality',
    reason: 'Your system has plenty of RAM — 9B model gives the best search & summary quality.',
  },
  {
    model: 'qwen3.5:4b',
    sizeGb: 2.7,
    minRamGb: 10,
    label: 'Balanced',
    reason: 'Good balance of speed and quality for your available memory.',
  },
  {
    model: 'llama3.2:3b',
    sizeGb: 2.0,
    minRamGb: 6,
    label: 'Recommended',
    reason: 'Great fit — fast, lightweight, and works well for chat search and summaries.',
  },
  {
    model: 'phi3:mini',
    sizeGb: 2.3,
    minRamGb: 4,
    label: 'Lightweight',
    reason: 'Your system has limited RAM — this small model keeps things responsive.',
  },
  {
    model: 'llama3.2:1b',
    sizeGb: 1.3,
    minRamGb: 0,
    label: 'Minimal',
    reason: 'Smallest option for very limited hardware. Quality is basic but functional.',
  },
];

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
        const [name, memMb] = nv.trim().split(',').map(s => s.trim());
        if (name) return { name, vramGb: memMb ? Math.round(parseInt(memMb, 10) / 1024) : null, type: 'nvidia' };
      } catch { /* no nvidia */ }
    }
  } catch { /* silent */ }
  return null;
}

/**
 * Returns system hardware info + best model recommendation.
 * Called once from the /api/ollama/recommend endpoint.
 */
export async function getHardwareRecommendation(ollamaProvider) {
  const totalRamGb = Math.round(os.totalmem() / (1024 ** 3));
  const freeRamGb = Math.round(os.freemem() / (1024 ** 3));
  const cpuCores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'Unknown';
  const gpu = detectGpu();

  // On Apple Silicon, unified memory means the full RAM is available for inference.
  const effectiveRam = gpu?.type === 'apple' ? totalRamGb : (gpu?.vramGb || totalRamGb);

  const recommended = MODEL_TIERS.find(t => effectiveRam >= t.minRamGb) || MODEL_TIERS[MODEL_TIERS.length - 1];

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
        localModels = (data.models || []).map(m => m.name);
        modelAvailable = localModels.some(
          m => m === recommended.model || m === `${recommended.model}:latest` || m.startsWith(`${recommended.model}:`)
        );
      }
    }
  } catch { /* ollama not running */ }

  return {
    hardware: {
      ram: totalRamGb,
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
      reason: recommended.reason,
      available: modelAvailable,
    },
    localModels,
    allTiers: MODEL_TIERS.map(t => ({
      model: t.model,
      sizeGb: t.sizeGb,
      minRamGb: t.minRamGb,
      label: t.label,
      fits: effectiveRam >= t.minRamGb,
    })),
  };
}
