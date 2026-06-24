/**
 * WhatsApp-first SMB vertical profiles — tunes search prompts, fact extraction,
 * action items, and synthesis for clinics, real estate, and D2C businesses.
 */

export const SMB_PROFILE_SETTING = 'smb_profile';
export const SMB_BUSINESS_NAME_SETTING = 'smb_business_name';

/** @typedef {'personal' | 'clinic' | 'real_estate' | 'd2c'} SmbProfileId */

/** @type {Record<SmbProfileId, object>} */
export const SMB_PROFILES = {
  personal: {
    id: 'personal',
    label: 'Personal',
    tagline: 'Search your personal chats',
    isBusiness: false,
  },
  clinic: {
    id: 'clinic',
    label: 'Clinic / Healthcare',
    tagline: 'Appointments, follow-ups, and patient messages',
    isBusiness: true,
    factTypes: ['appointment', 'prescription', 'payment', 'meeting', 'question'],
    factAddon: `Also extract these SMB types when relevant:
- "appointment": patient_name, when, reason, status ("requested"|"confirmed"|"cancelled"|"unknown")
- "prescription": medicine, dosage, patient_name, context
Use "meeting" for consultations; "payment" for fees, bills, UPI.`,
    searchPrompts: [
      { label: 'Appointments', query: 'Which patients asked for or confirmed appointments? Include dates and times mentioned.' },
      { label: 'Follow-ups due', query: 'Which patients need a follow-up call or message? Include what was promised.' },
      { label: 'Payments pending', query: 'List consultation fees or payments discussed but not confirmed as received.' },
      { label: 'Prescriptions', query: 'What medicines or prescriptions were discussed? Include dosage if mentioned.' },
      { label: 'Lab reports', query: 'Which patients shared or asked about lab reports or test results?' },
    ],
    synthesisAddon: 'The user runs a clinic or healthcare practice on WhatsApp. Prioritize patient names, appointment dates/times, symptoms, prescriptions, fees, and follow-up commitments. Use professional tone.',
    actionAddon: 'Healthcare context: flag appointment requests, report sharing, prescription refills, payment reminders, and urgent symptoms.',
    inboxFactQuery: 'appointment payment prescription follow-up lab report',
  },
  real_estate: {
    id: 'real_estate',
    label: 'Real Estate',
    tagline: 'Site visits, leads, and deal tracking',
    isBusiness: true,
    factTypes: ['site_visit', 'lead', 'payment', 'meeting', 'question'],
    factAddon: `Also extract these SMB types when relevant:
- "site_visit": property, when, buyer_name, location, status ("scheduled"|"done"|"cancelled"|"unknown")
- "lead": buyer_name, budget, property_interest, source, temperature ("hot"|"warm"|"cold"|"unknown")
Use "payment" for token, booking amount, brokerage.`,
    searchPrompts: [
      { label: 'Site visits', query: 'Which site visits or property showings were scheduled or completed? Include property names and dates.' },
      { label: 'Hot leads', query: 'Which buyers showed strong interest, asked for visits, or discussed budget seriously?' },
      { label: 'Deals in progress', query: 'Summarize negotiations, token amounts, or deals that are still open.' },
      { label: 'Properties discussed', query: 'List properties, projects, or localities mentioned most often with buyer interest.' },
      { label: 'Callbacks needed', query: 'Which leads asked for a call back or more details and have not received a clear answer?' },
    ],
    synthesisAddon: 'The user is a real-estate agent or broker on WhatsApp. Prioritize property names, budgets, site visit dates, lead names, and deal stage. Be specific about locations and amounts.',
    actionAddon: 'Real-estate context: flag site visit requests, budget discussions, document sharing, and leads waiting for callback.',
    inboxFactQuery: 'site visit property budget token booking lead',
  },
  d2c: {
    id: 'd2c',
    label: 'D2C / Online Store',
    tagline: 'Orders, delivery, and customer support',
    isBusiness: true,
    factTypes: ['order', 'payment', 'delivery', 'complaint', 'question'],
    factAddon: `Also extract these SMB types when relevant:
- "order": product, quantity, customer_name, order_id, status ("placed"|"shipped"|"delivered"|"cancelled"|"unknown")
- "delivery": address, pincode, expected_date, courier, status
- "complaint": product, issue, customer_name, severity ("low"|"medium"|"high")
Use "payment" for COD, UPI, refunds.`,
    searchPrompts: [
      { label: 'Open orders', query: 'Which orders are placed but not clearly delivered or confirmed? Include product and customer.' },
      { label: 'Delivery issues', query: 'Summarize delivery delays, wrong address, or courier problems mentioned in chats.' },
      { label: 'Refunds & returns', query: 'Which customers asked for refunds, returns, or exchanges? What was the reason?' },
      { label: 'Top products', query: 'Which products or SKUs are customers asking about or ordering most?' },
      { label: 'Unpaid orders', query: 'List payment pending, failed UPI, or COD confirmation issues.' },
    ],
    synthesisAddon: 'The user runs a D2C or online store on WhatsApp. Prioritize order IDs, products, quantities, delivery addresses, payment status, and complaints. Be actionable for support staff.',
    actionAddon: 'E-commerce context: flag new orders, address confirmations, payment screenshots, delivery complaints, and refund requests.',
    inboxFactQuery: 'order delivery payment refund complaint address',
  },
};

/**
 * @param {string | null | undefined} id
 * @returns {typeof SMB_PROFILES.personal}
 */
export function resolveSmbProfile(id) {
  const key = String(id || 'personal').trim().toLowerCase();
  return SMB_PROFILES[key] || SMB_PROFILES.personal;
}

/**
 * @param {import('../storage/database.js').default} db
 * @returns {typeof SMB_PROFILES.personal}
 */
export function getSmbProfileFromDb(db) {
  if (!db || typeof db.getSetting !== 'function') return SMB_PROFILES.personal;
  return resolveSmbProfile(db.getSetting(SMB_PROFILE_SETTING));
}

/**
 * @param {typeof SMB_PROFILES.personal} profile
 * @returns {Array<{ label: string, query: string }>}
 */
export function getSearchPrompts(profile) {
  if (!profile?.isBusiness) return [];
  return profile.searchPrompts || [];
}

/**
 * @param {typeof SMB_PROFILES.personal} profile
 * @returns {string}
 */
export function synthesisSystemAddon(profile) {
  if (!profile?.isBusiness || !profile.synthesisAddon) return '';
  return profile.synthesisAddon;
}

/**
 * @param {typeof SMB_PROFILES.personal} profile
 * @returns {string}
 */
export function factExtractionAddon(profile) {
  if (!profile?.isBusiness || !profile.factAddon) return '';
  return profile.factAddon;
}

/**
 * @param {typeof SMB_PROFILES.personal} profile
 * @returns {string}
 */
export function actionItemAddon(profile) {
  if (!profile?.isBusiness || !profile.actionAddon) return '';
  return profile.actionAddon;
}

/**
 * @param {typeof SMB_PROFILES.personal} profile
 * @returns {string}
 */
export function inboxFactSearchQuery(profile) {
  if (!profile?.isBusiness) return '';
  return profile.inboxFactQuery || '';
}

/**
 * @returns {Array<{ id: string, label: string, tagline: string, isBusiness: boolean }>}
 */
export function listSmbProfileOptions() {
  return Object.values(SMB_PROFILES).map((p) => ({
    id: p.id,
    label: p.label,
    tagline: p.tagline,
    isBusiness: !!p.isBusiness,
  }));
}
