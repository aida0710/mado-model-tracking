import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface ExclusiveAudio {
  /** A stable callback per player id, usable as `ref` or AudioArtifactViewer's onAudioElement. */
  register: (playerId: string) => (element: HTMLAudioElement | null) => void;
  /** Call from the player's onPlay; pauses every other player. */
  played: (playerId: string) => void;
}

/**
 * Lets only one of several <audio> elements sound at a time, and silences all of them when the
 * owner unmounts (for example when the step slider moves to another step).
 */
export function useExclusiveAudio(): ExclusiveAudio {
  const players = useRef(new Map<string, HTMLAudioElement>());
  const registrations = useRef(new Map<string, (element: HTMLAudioElement | null) => void>());

  useEffect(() => {
    const current = players.current;
    return () => {
      for (const player of current.values()) player.pause();
    };
  }, []);

  const register = useCallback((playerId: string) => {
    let registration = registrations.current.get(playerId);
    if (!registration) {
      registration = (element) => {
        if (element) players.current.set(playerId, element);
        else players.current.delete(playerId);
      };
      registrations.current.set(playerId, registration);
    }
    return registration;
  }, []);
  const played = useCallback((playerId: string) => {
    for (const [otherId, player] of players.current) if (otherId !== playerId) player.pause();
  }, []);
  return useMemo(() => ({ register, played }), [register, played]);
}
