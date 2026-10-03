import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';

export interface Coords {
  lat: number;
  lng: number;
}

export type LocationPermission = 'unknown' | 'granted' | 'denied';

/**
 * One-shot device location with an explicit permission state, so screens can
 * explain *why* they need it instead of silently failing. A production build
 * would add a watch subscription and background updates; start here.
 */
export function useCurrentLocation() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [permission, setPermission] = useState<LocationPermission>('unknown');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const current = await Location.getForegroundPermissionsAsync();
      let status = current.status;
      if (status !== 'granted') {
        const requested = await Location.requestForegroundPermissionsAsync();
        status = requested.status;
      }
      if (status !== 'granted') {
        setPermission('denied');
        setError('Location permission is required to request a ride.');
        return;
      }
      setPermission('granted');
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
    } catch {
      setError('Could not read your location. Try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { coords, permission, loading, error, refresh };
}
