import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { Alert, ActivityIndicator, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Contacts from 'expo-contacts';

const SESSION_KEY = 'wa_session_id';

export default function App() {
  const [baseUrl, setBaseUrl] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [contactsPerm, setContactsPerm] = useState('undetermined'); // undetermined | granted | denied
  const [contactsPreview, setContactsPreview] = useState([]);
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const savedBase = await AsyncStorage.getItem('baseUrl');
        const saved = await AsyncStorage.getItem(SESSION_KEY);
        await AsyncStorage.removeItem('auth_jwt');
        if (savedBase) setBaseUrl(savedBase);
        if (saved) setSessionId(saved);
      } catch { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem('baseUrl', baseUrl || '').catch(() => {});
  }, [baseUrl]);

  useEffect(() => {
    (async () => {
      try {
        const p = await Contacts.getPermissionsAsync();
        setContactsPerm(p?.status || 'undetermined');
      } catch { /* ignore */ }
    })();
  }, []);

  function bu() {
    return (baseUrl || '').trim().replace(/\/$/, '');
  }

  async function ensureServerSession() {
    const root = bu();
    if (!root?.startsWith('http')) {
      return Alert.alert('Base URL', 'Enter a valid server URL (https://...).');
    }
    setLoading(true);
    try {
      const headers = {};
      if (sessionId) headers['Authorization'] = `Bearer ${sessionId}`;
      const r = await fetch(`${root}/api/auth/ensure`, { headers, credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Could not get session. Is SESSION_SECRET (or JWT_SECRET) set on the server?');
      if (!j?.sessionId) throw new Error('No session in response');
      setSessionId(j.sessionId);
      await AsyncStorage.setItem(SESSION_KEY, j.sessionId);
    } catch (e) {
      Alert.alert('Connect error', e.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }

  async function doSearch() {
    if (!sessionId) return Alert.alert('Connect first', 'Use Connect to get a server-issued session.');
    if (!query.trim()) return;
    setLoading(true);
    setAnswer('');
    setSources([]);
    try {
      const r = await fetch(`${bu()}/api/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ query: query.trim(), chatJid: null, mediaType: null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Search failed');
      setAnswer(j.answer || '');
      setSources(Array.isArray(j.sources) ? j.sources : []);
    } catch (e) {
      Alert.alert('Search error', e.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  async function syncContacts() {
    if (!sessionId) return Alert.alert('Connect first', 'Use Connect to get a server-issued session.');
    setSyncingContacts(true);
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      setContactsPerm(status || 'undetermined');
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow Contacts permission to sync names and show contact names.');
        return;
      }
      const res = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
        pageSize: 5000,
        pageOffset: 0,
      });
      const data = Array.isArray(res.data) ? res.data : [];
      const payload = [];
      for (const c of data) {
        const name = (c.name || '').trim();
        if (!name) continue;
        const phones = (c.phoneNumbers || [])
          .map((p) => (p?.number || '').trim())
          .filter(Boolean);
        if (!phones.length) continue;
        payload.push({ name, phones });
      }
      if (!payload.length) {
        Alert.alert('No contacts', 'No contacts with phone numbers found.');
        return;
      }
      const r = await fetch(`${bu()}/api/contacts/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({ contacts: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Sync failed');
      Alert.alert('Contacts synced', `Uploaded ${j.inserted || 0} entries.\nUpdated ${j.updatedChats || 0} message rows.`);
    } catch (e) {
      Alert.alert('Sync error', e.message || 'Sync failed');
    } finally {
      setSyncingContacts(false);
    }
  }

  async function requestContactsPermissionAndPreview() {
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      setContactsPerm(status || 'undetermined');
      if (status !== 'granted') return;
      const res = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
        pageSize: 200,
        pageOffset: 0,
      });
      const data = Array.isArray(res.data) ? res.data : [];
      const preview = [];
      for (const c of data) {
        const name = (c.name || '').trim();
        if (!name) continue;
        const phones = (c.phoneNumbers || [])
          .map((p) => (p?.number || '').trim())
          .filter(Boolean);
        if (!phones.length) continue;
        preview.push({ name, phone: phones[0] });
        if (preview.length >= 8) break;
      }
      setContactsPreview(preview);
    } catch { /* ignore */ }
  }

  async function logout() {
    if (sessionId) {
      try {
        await fetch(`${bu()}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionId}` },
        });
      } catch { /* ignore */ }
    }
    setSessionId(null);
    await AsyncStorage.removeItem(SESSION_KEY).catch(() => {});
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>WhatsApp Search</Text>
        {sessionId ? (
          <TouchableOpacity onPress={logout}>
            <Text style={styles.link}>Clear session</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://your-app.onrender.com"
        autoCapitalize="none"
        style={styles.input}
      />

      <View style={styles.card}>
        <Text style={styles.hint}>
          The server issues an opaque session (no password on the device). Use Connect, then search on the same tenant as
          the web.
        </Text>
        <TouchableOpacity style={styles.btn} onPress={ensureServerSession} disabled={loading}>
          <Text style={styles.btnText}>{sessionId ? 'Refresh session' : 'Connect'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Contacts (Phone book)</Text>
        <Text style={styles.hint}>
          If you allow access, we can sync contact names to improve chat name display. Your server stores phones hashed and
          names encrypted at rest.
        </Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.btn, styles.btnSecondary]}
            onPress={requestContactsPermissionAndPreview}
            disabled={loading}
          >
            <Text style={[styles.btnText, styles.btnSecondaryText]}>
              {contactsPerm === 'granted' ? 'Show contacts' : 'Allow Contacts'}
            </Text>
          </TouchableOpacity>
          {sessionId ? (
            <TouchableOpacity
              style={[styles.btn, styles.btnSecondary]}
              onPress={syncContacts}
              disabled={syncingContacts || loading}
            >
              <Text style={[styles.btnText, styles.btnSecondaryText]}>
                {syncingContacts ? 'Syncing…' : 'Sync to server'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {contactsPerm !== 'granted' ? (
          <Text style={[styles.hint, { marginTop: 10 }]}>
            Permission status: {String(contactsPerm || 'undetermined')}
          </Text>
        ) : null}
        {contactsPreview.length ? (
          <View style={{ marginTop: 10 }}>
            <Text style={styles.sourcesTitle}>Preview</Text>
            {contactsPreview.map((c, idx) => (
              <Text key={idx} style={styles.sourceLine}>
                • {c.name} — {c.phone}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {sessionId ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>AI Search</Text>
          <TextInput value={query} onChangeText={setQuery} placeholder="Ask anything about your chats…" style={styles.input} />
          <TouchableOpacity style={styles.btn} onPress={doSearch} disabled={loading}>
            <Text style={styles.btnText}>Search</Text>
          </TouchableOpacity>
          {loading ? <ActivityIndicator style={{ marginTop: 10 }} /> : null}
          {answer ? <Text style={styles.answer}>{answer}</Text> : null}
          {sources.length ? (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.sourcesTitle}>Sources</Text>
              {sources.slice(0, 5).map((s, idx) => (
                <Text key={idx} style={styles.sourceLine}>
                  • {(s.sender || 'Unknown')}: {(s.text || '').slice(0, 120)}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f2f5',
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 18, fontWeight: '700', color: '#111b21' },
  link: { color: '#008069', fontWeight: '700' },
  label: { color: '#667781', fontSize: 12, marginBottom: 6 },
  hint: { color: '#667781', fontSize: 12, lineHeight: 16, marginBottom: 10 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e9edef',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e9edef', marginBottom: 12 },
  cardTitle: { fontSize: 14, fontWeight: '700', marginBottom: 10, color: '#111b21' },
  row: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    backgroundColor: '#00a884',
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
  },
  btnSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e9edef' },
  btnText: { color: '#fff', fontWeight: '800' },
  btnSecondaryText: { color: '#008069' },
  answer: { marginTop: 12, color: '#111b21', lineHeight: 18 },
  sourcesTitle: { fontWeight: '800', color: '#111b21', marginBottom: 6 },
  sourceLine: { color: '#667781', marginBottom: 4, fontSize: 12 },
});
