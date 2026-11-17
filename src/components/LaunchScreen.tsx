import './launch.css';

const stars = Array.from({ length: 52 }, (_, index) => ({
  left: `${(index * 73 + 11) % 101}%`,
  top: `${(index * 31 + 7) % 97}%`,
  size: index % 9 === 0 ? 3 : index % 3 === 0 ? 2 : 1,
  delay: `${-index % 7}s`,
  duration: `${3 + (index % 4)}s`,
}));

export function LaunchScreen({
  fading = false,
  status,
  children,
}: {
  fading?: boolean;
  status: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      className={`launch-screen ${fading ? 'launch-screen--leaving' : ''}`}
      aria-label="GITVerse launch screen"
      aria-busy={!children}
    >
      <div className="launch-nebula" aria-hidden />
      <div className="launch-stars" aria-hidden>
        {stars.map((star, index) => (
          <span
            key={index}
            style={{
              left: star.left,
              top: star.top,
              width: star.size,
              height: star.size,
              animationDelay: star.delay,
              animationDuration: star.duration,
            }}
          />
        ))}
      </div>
      <div className="launch-content">
        <div className="launch-stage" aria-hidden>
          <div className="launch-orbit-formation">
            <svg className="launch-orbit" viewBox="0 0 320 320" fill="none">
              <circle cx="160" cy="160" r="132" stroke="#c084fc" strokeWidth="1.5" />
              <circle cx="160" cy="160" r="144" stroke="#a78bfa" strokeWidth="1" strokeDasharray="1 13" />
              <path d="M28 160A132 132 0 0 1 160 28" stroke="#f0abfc" strokeWidth="4" strokeLinecap="round" />
              <circle cx="160" cy="28" r="8" fill="#c084fc" />
              <circle cx="292" cy="160" r="5" fill="#67e8f9" />
              <circle cx="160" cy="292" r="6" fill="#f0abfc" />
              <circle cx="28" cy="160" r="4" fill="#a5f3fc" />
            </svg>
          </div>
          <svg className="launch-graph" viewBox="0 0 128 128" fill="none">
            <path d="M44 85V41M44 76C44 57 86 74 86 53" stroke="#22d3ee" strokeWidth="8" strokeLinecap="round" />
            <circle cx="44" cy="30" r="10" fill="#0b1730" stroke="#67e8f9" strokeWidth="6" />
            <circle cx="86" cy="42" r="10" fill="#0b1730" stroke="#22d3ee" strokeWidth="6" />
            <circle cx="44" cy="96" r="10" fill="#0b1730" stroke="#06b6d4" strokeWidth="6" />
            <circle className="launch-data" r="3" fill="#ecfeff">
              <animateMotion dur="1.8s" repeatCount="indefinite" path="M44 85V41" />
            </circle>
          </svg>
        </div>
        <h1 className="launch-name">
          GIT<span>Verse</span>
        </h1>
        <p className="launch-status" role="status">
          {status}
        </p>
        {children && <div className="launch-actions">{children}</div>}
      </div>
      <small className="launch-credit">
        Orion Nebula: NASA, ESA, M. Robberto (STScI/ESA), Hubble Space Telescope Orion Treasury Project Team
      </small>
    </section>
  );
}
