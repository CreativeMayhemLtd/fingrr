import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRelay } from '@/hooks/useRelay';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function RootLayoutInner() {
  useRelay();
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
