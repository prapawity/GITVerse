import './launch.css';

const stars = Array.from({ length: 52 }, (_, index) => ({
  left: `${(index * 73 + 11) % 101}%`,
  top: `${(index * 31 + 7) % 97}%`,
  size: index % 9 === 0 ? 3 : index % 3 === 0 ? 2 : 1,
  delay: `${-index % 7}s`,
  duration: `${3 + (index % 4)}s`,
}));

const comets = [
  { top: '8%', left: '30%', delay: '0.05s', duration: '2.2s' },
  { top: '24%', left: '74%', delay: '0.25s', duration: '2.4s' },
  { top: '4%', left: '94%', delay: '0.45s', duration: '2.6s' },
  { top: '42%', left: '58%', delay: '0.65s', duration: '2.2s' },
  { top: '18%', left: '46%', delay: '0.9s', duration: '2.4s' },
  { top: '56%', left: '90%', delay: '1.15s', duration: '2.6s' },
  { top: '30%', left: '82%', delay: '1.4s', duration: '2.2s' },
  { top: '10%', left: '66%', delay: '1.65s', duration: '2.4s' },
];

const commits = [0, 1, 2, 3, 4];

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
      aria-label="GITVerse by PRAPAWITY launch screen"
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
      <div className="launch-comets" aria-hidden>
        {comets.map((comet, index) => (
          <span
            key={index}
            style={{
              top: comet.top,
              left: comet.left,
              animationDelay: comet.delay,
              animationDuration: comet.duration,
            }}
          />
        ))}
      </div>
      <div className="launch-content">
        <h1 className="launch-name">
          GIT<span>Verse</span> <small className="launch-byline">by PRAPAWITY</small>
        </h1>
        {!children && (
          <div className="launch-track" aria-hidden>
            <span className="launch-track-line" />
            <span className="launch-track-pulse" />
            {commits.map((index) => (
              <span
                key={index}
                className="launch-track-node"
                style={{ left: `${index * 25}%`, animationDelay: `${index * 0.24}s` }}
              />
            ))}
          </div>
        )}
        <p className="launch-status" role="status">
          {status}
        </p>
        {children && <div className="launch-actions">{children}</div>}
      </div>
    </section>
  );
}
