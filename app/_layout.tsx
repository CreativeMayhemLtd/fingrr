import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { usePeerConnection } from '@/hooks/usePeerConnection';
import { useContactsStore } from '@/store/contacts';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function RootLayoutInner() {
  usePeerConnection();
  const loadFromDB = useContactsStore(s => s.loadFromDB);

  useEffect(() => {
    loadFromDB();
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <RootLayoutInner />
    </ErrorBoundary>
  );
}
