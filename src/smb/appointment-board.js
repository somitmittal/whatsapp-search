/**
 * Clinic appointment board — surfaces appointment/meeting facts from thread index.
 */
import { getSmbProfileFromDb } from './profiles.js';

const APPOINTMENT_FACT_TYPES = new Set(['appointment', 'meeting']);

/**
 * @param {object} payload
 * @returns {string}
 */
function summarizeAppointmentPayload(payload, factType) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  if (payload.patient_name) parts.push(payload.patient_name);
  if (payload.when) parts.push(payload.when);
  if (payload.reason) parts.push(payload.reason);
  if (payload.topic) parts.push(payload.topic);
  if (payload.status) parts.push(`(${payload.status})`);
  if (payload.summary) parts.push(payload.summary);
  if (!parts.length && factType === 'meeting') {
    if (payload.attendees?.length) parts.push(payload.attendees.join(', '));
  }
  return parts.join(' · ').trim();
}

/**
 * @param {object} row thread_facts row
 * @returns {object}
 */
export function mapFactToAppointment(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payloadJson || '{}');
  } catch { /* */ }
  const status = String(payload.status || 'unknown').toLowerCase();
  return {
    id: row.id,
    chatJid: row.chatJid,
    chatName: row.chatName,
    factType: row.factType,
    patientName: payload.patient_name || payload.patientName || row.chatName || null,
    when: payload.when || payload.dates_mentioned || null,
    reason: payload.reason || payload.topic || null,
    status,
    summary: summarizeAppointmentPayload(payload, row.factType),
    threadStart: row.threadStart,
    threadEnd: row.threadEnd,
    sortTs: row.threadEnd || row.threadStart || 0,
  };
}

export default class AppointmentBoardService {
  /** @param {import('../storage/database.js').default} db */
  constructor(db) {
    this.db = db;
  }

  getBoard() {
    const profile = getSmbProfileFromDb(this.db);
    if (profile.id !== 'clinic') {
      return { enabled: false, profile: profile.id, appointments: [] };
    }

    const rows = this.db.listThreadFactsByTypes([...APPOINTMENT_FACT_TYPES], 80);
    const appointments = rows
      .map(mapFactToAppointment)
      .sort((a, b) => (b.sortTs || 0) - (a.sortTs || 0));

    const grouped = {
      requested: appointments.filter((a) => a.status === 'requested'),
      confirmed: appointments.filter((a) => a.status === 'confirmed'),
      cancelled: appointments.filter((a) => a.status === 'cancelled'),
      other: appointments.filter((a) => !['requested', 'confirmed', 'cancelled'].includes(a.status)),
    };

    return {
      enabled: true,
      profile: profile.id,
      appointments,
      grouped,
      stats: {
        total: appointments.length,
        requested: grouped.requested.length,
        confirmed: grouped.confirmed.length,
        cancelled: grouped.cancelled.length,
      },
    };
  }
}
