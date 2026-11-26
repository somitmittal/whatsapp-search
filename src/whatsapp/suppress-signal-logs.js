const SIGNAL_FILTER_INSTALLED = Symbol.for('searchable.signalLogFilterInstalled');

const SIGNAL_LOG_PREFIXES = [
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Session already closed',
  'Closing open session in favor of incoming prekey bundle',
];

function isSignalSessionObject(arg) {
  if (!arg || typeof arg !== 'object') return false;
  return Boolean(
    arg.currentRatchet?.ephemeralKeyPair
    || (arg.indexInfo && arg.registrationId !== undefined && arg._chains),
  );
}

/**
 * Returns true if the console arguments come from libsignal's raw SessionEntry
 * debug dumps (which print ephemeralKeyPair / rootKey / chainKey to stdout).
 */
export function isSignalSessionLog(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const first = args[0];
  if (typeof first === 'string' && SIGNAL_LOG_PREFIXES.some((prefix) => first.startsWith(prefix))) {
    return true;
  }
  return args.some(isSignalSessionObject);
}

/**
 * Idempotently wraps `console.info`, `console.warn`, and `console.log` to drop
 * libsignal's noisy/sensitive SessionEntry dumps (ephemeralKeyPair, etc.).
 */
export function installSignalLogFilter(targetConsole = console) {
  if (!targetConsole || targetConsole[SIGNAL_FILTER_INSTALLED]) return;
  targetConsole[SIGNAL_FILTER_INSTALLED] = true;

  for (const method of ['info', 'warn', 'log']) {
    const orig = targetConsole[method];
    if (typeof orig !== 'function') continue;
    targetConsole[method] = (...args) => {
      if (isSignalSessionLog(args)) return;
      return orig.apply(targetConsole, args);
    };
  }
}
