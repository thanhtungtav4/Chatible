/**
 * Provides gentle haptic tactile feedback on mobile devices that support the Vibration API
 */
export type HapticType = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

export function triggerHaptic(type: HapticType = 'light'): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;

  try {
    switch (type) {
      case 'light':
        navigator.vibrate(12);
        break;
      case 'medium':
        navigator.vibrate(22);
        break;
      case 'heavy':
        navigator.vibrate(38);
        break;
      case 'success':
        navigator.vibrate([15, 45, 25]);
        break;
      case 'warning':
        navigator.vibrate([25, 30, 25]);
        break;
      case 'error':
        navigator.vibrate([40, 40, 40]);
        break;
    }
  } catch {
    // Vibration API may throw or be blocked by browser policies
  }
}
