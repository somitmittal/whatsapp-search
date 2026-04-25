import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, ActivityIndicator, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Contacts from 'expo-contacts';

export default function App() {
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [query, setQuery] = useState('');
  const [jwt, setJwt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const savedBase = await AsyncStorage.getItem('baseUrl');
        const savedJwt = await AsyncStorage.getItem('auth_jwt');
        if (savedBase) setBaseUrl(savedBase);
        if (savedJwt) setJwt(savedJwt);
      } catch { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem('baseUrl', baseUrl || '').catch(() => {});
  }, [baseUrl]);

  async function auth(path) {
    if (!baseUrl?.startsWith('http')) return Alert.alert('Base URL', 'Enter a valid server URL (https://...)');
    if (!email.includes('@') || password.length < 8) return Alert.alert('Login', 'Enter email + password (8+ chars).');
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.token) throw new Error(j?.error || 'Auth failed');
      setJwt(j.token);
      await AsyncStorage.setItem('auth_jwt', j.token);
    } catch (e) {
      Alert.alert('Auth error', e.message || 'Auth failed');
    } finally {
      setLoading(false);
    }
  }

  async function doSearch() {
    if (!jwt) return Alert.alert('Login required', 'Please login first.');
    if (!query.trim()) return;
    setLoading(true);
    setAnswer('');
    setSources([]);
    try {
      const r = await fetch(`${baseUrl}/api/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
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
    if (!jwt) return Alert.alert('Login required', 'Please login first.');
    if (!baseUrl?.startsWith('http')) return Alert.alert('Base URL', 'Enter a valid server URL (https://...)');
    setSyncingContacts(true);
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow Contacts permission to sync names.');
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
      const r = await fetch(`${baseUrl}/api/contacts/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
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

  async function logout() {
    setJwt(null);
    await AsyncStorage.removeItem('auth_jwt').catch(() => {});
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>WhatsApp Search</Text>
        {jwt ? (
          <TouchableOpacity onPress={logout}>
            <Text style={styles.link}>Logout</Text>
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

      {!jwt ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Login / Register</Text>
          <TextInput value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" style={styles.input} />
          <TextInput value={password} onChangeText={setPassword} placeholder="Password (8+ chars)" secureTextEntry style={styles.input} />
          <View style={styles.row}>
            <TouchableOpacity style={styles.btn} onPress={() => auth('/api/auth/login')} disabled={loading}>
              <Text style={styles.btnText}>Login</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => auth('/api/auth/register')} disabled={loading}>
              <Text style={[styles.btnText, styles.btnSecondaryText]}>Register</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>AI Search</Text>
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={syncContacts} disabled={syncingContacts || loading}>
              <Text style={[styles.btnText, styles.btnSecondaryText]}>{syncingContacts ? 'Syncing…' : 'Sync Contacts'}</Text>
            </TouchableOpacity>
          </View>
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
      )}

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
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e9edef' },
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
