import { useCallback, useEffect, useRef, useState } from 'react';

export interface LoopRange {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Follows an <audio> element's position every animation frame while it plays (timeupdate fires only
 * about 4 times a second, too coarse for a playhead) and keeps playback inside the loop range.
 */
export function useAudioPlayback(audio: HTMLAudioElement | null, loop: LoopRange | null) {
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => {
    if (!audio) return;
    let frame = 0;
    const tick = () => {
      const range = loopRef.current;
      if (range && audio.currentTime >= range.endSeconds) audio.currentTime = range.startSeconds;
      setCurrentTime(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onStop = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      setCurrentTime(audio.currentTime);
    };
    const onSeeked = () => setCurrentTime(audio.currentTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onStop);
    audio.addEventListener('ended', onStop);
    audio.addEventListener('seeked', onSeeked);
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onStop);
      audio.removeEventListener('ended', onStop);
      audio.removeEventListener('seeked', onSeeked);
    };
  }, [audio]);

  const seek = useCallback(
    (seconds: number) => {
      if (!audio) return;
      audio.currentTime = Math.max(0, seconds);
      setCurrentTime(audio.currentTime);
    },
    [audio],
  );
  const togglePlayback = useCallback(() => {
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [audio]);
  return { currentTime, playing, seek, togglePlayback };
}
