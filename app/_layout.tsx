import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { usePeerConnection } from '@/hooks/usePeerConnection';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { registerForPushNotifications, publishPushToken, setupNotificationTapHandler } from '@/services/notifications';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function RootLayoutInner() {
  usePeerConnection();
  const loadFromDB = useContactsStore(s => s.loadFromDB);
  const isInitialized = useIdentityStore(s => s.isInitialized);

  useEffect(() => {
    loadFromDB();
    // Register for push notifications and publish token to keybundle
    registerForPushNotifications().then(token => {
      if (token) publishPushToken(token);
    });
    // Tap on push notification → navigate to conversation
    const cleanup = setupNotificationTapHandler();
    return cleanup;
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
