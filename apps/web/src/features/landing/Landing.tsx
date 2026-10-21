'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Logo } from '../../components/ui/Logo';
import { AgentFlock } from './AgentFlock';
import { useReducedMotion } from './use-reduced-motion';

/** The reference hero's mark → centered wordmark → asymmetric composition. */
export function Landing({ children }: { children: ReactNode }) {
  const section = useRef<HTMLElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const root = section.current;
    if (!root || reduced) return;
    const wordmark = root.querySelector<HTMLElement>('.landing-wordmark');
    if (!wordmark) return;
    const rect = wordmark.getBoundingClientRect();
    const x = window.innerWidth / 2 - (rect.left + rect.width / 2);
    const y = window.innerHeight / 2 - (rect.top + rect.height / 2);
    const centered = `translate(${x}px, ${y}px)`;
    const animation = wordmark.animate([
      { opacity: 0, transform: centered, offset: 0 },
      { opacity: 0, transform: centered, offset: 0.5 },
      { opacity: 1, transform: centered, offset: 0.7 },
      { opacity: 1, transform: centered, offset: 0.77, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      { opacity: 1, transform: 'translate(0, 0)', offset: 1 },
    ], { duration: 3510 });
    root.dataset.intro = 'running';
    const finish = () => { delete root.dataset.intro; };
    const timer = window.setTimeout(finish, 4300);
    // Resizing or navigating by keyboard makes the complete page immediately available.
    const stop = () => { animation.cancel(); finish(); window.clearTimeout(timer); };
    window.addEventListener('resize', stop);
    root.addEventListener('focusin', stop);
    return () => {
      stop();
      window.removeEventListener('resize', stop);
      root.removeEventListener('focusin', stop);
    };
  }, [reduced]);

  useEffect(() => {
    const root = section.current;
    const dot = cursor.current;
    const fine = window.matchMedia('(pointer: fine)');
    if (!root || !dot || reduced) return;
    const move = (event: PointerEvent) => {
      if (!fine.matches || event.pointerType === 'touch') return;
      dot.style.transform = `translate3d(${event.clientX - 8}px, ${event.clientY - 8}px, 0)`;
      root.dataset.cursor = 'visible';
    };
    const hide = () => { delete root.dataset.cursor; };
    root.addEventListener('pointermove', move, { passive: true });
    root.addEventListener('pointerleave', hide);
    root.addEventListener('focusin', hide);
    window.addEventListener('blur', hide);
    fine.addEventListener('change', hide);
    return () => {
      hide();
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', hide);
      root.removeEventListener('focusin', hide);
      window.removeEventListener('blur', hide);
      fine.removeEventListener('change', hide);
    };
  }, [reduced]);

  return (
    <section ref={section} className="landing" aria-labelledby="landing-title">
      <AgentFlock count={94} tone="ink" className="landing-flock" />
      <div className="landing-composition">{children}</div>
      <div className="landing-intro" aria-hidden="true"><Logo className="landing-intro-mark" /></div>
      <div ref={cursor} className="landing-cursor" aria-hidden="true" />
    </section>
  );
}
