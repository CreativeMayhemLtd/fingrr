// Entry point: the crypto polyfill MUST load before expo-router/entry
// evaluates any route (and with it the @noble crypto stack).
import './src/polyfills';
import 'expo-router/entry';
