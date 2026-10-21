import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { usePeerConnection } from '@/hooks/usePeerConnection';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function RootLayoutInner() {
  usePeerConnection();
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
