import { describe, expect, it } from '@jest/globals';
import AppointmentBoardService, { mapFactToAppointment } from '../src/smb/appointment-board.js';

describe('appointment board', () => {
  it('maps fact row to appointment card', () => {
    const a = mapFactToAppointment({
      id: 1,
      chatJid: 'waba:+911',
      chatName: 'Priya',
      factType: 'appointment',
      threadStart: 100,
      threadEnd: 200,
      payloadJson: JSON.stringify({
        patient_name: 'Priya',
        when: 'Friday 4pm',
        reason: 'Follow-up',
        status: 'confirmed',
      }),
    });
    expect(a.patientName).toBe('Priya');
    expect(a.status).toBe('confirmed');
    expect(a.summary).toMatch(/Friday/);
  });

  it('returns disabled board for non-clinic profiles', () => {
    const db = { getSetting: () => 'd2c', listThreadFactsByTypes: () => [] };
    const board = new AppointmentBoardService(db).getBoard();
    expect(board.enabled).toBe(false);
  });

  it('groups clinic appointments by status', () => {
    const db = {
      getSetting: (k) => (k === 'smb_profile' ? 'clinic' : ''),
      listThreadFactsByTypes: () => [
        {
          id: 1, chatJid: 'a', chatName: 'A', factType: 'appointment', threadStart: 1, threadEnd: 2,
          payloadJson: JSON.stringify({ status: 'requested', patient_name: 'A' }),
        },
        {
          id: 2, chatJid: 'b', chatName: 'B', factType: 'appointment', threadStart: 3, threadEnd: 4,
          payloadJson: JSON.stringify({ status: 'confirmed', patient_name: 'B' }),
        },
      ],
    };
    const board = new AppointmentBoardService(db).getBoard();
    expect(board.enabled).toBe(true);
    expect(board.stats.total).toBe(2);
    expect(board.grouped.confirmed).toHaveLength(1);
    expect(board.grouped.requested).toHaveLength(1);
  });
});
