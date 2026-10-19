import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';

interface State { error: Error | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={s.container}>
        <Text style={s.title}>Render error</Text>
        <Text style={s.msg}>{error.message}</Text>
        <ScrollView style={s.stack}>
          <Text style={s.stackText}>{error.stack}</Text>
        </ScrollView>
        <TouchableOpacity style={s.btn} onPress={() => this.setState({ error: null })}>
          <Text style={s.btnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 20, justifyContent: 'center' },
  title: { color: '#ef4444', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  msg: { color: '#fca5a5', fontSize: 14, marginBottom: 12 },
  stack: { backgroundColor: '#1a1a1a', borderRadius: 6, padding: 10, maxHeight: 300, marginBottom: 16 },
  stackText: { color: '#888', fontSize: 11, fontFamily: 'monospace' },
  btn: { backgroundColor: '#2563eb', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600' },
});
