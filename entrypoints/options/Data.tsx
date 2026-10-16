import { Archive, HardDrive, Laptop, Server } from 'lucide-react';
import { DeleteData } from './DeleteData';
import { ArtTile, Card } from './ui';

/** "Your data": where it lives, where to take a copy, and the one irreversible control. */
export function YourData({ syncOn }: { syncOn: boolean }) {
  return (
    <div className="opt-stack">
      <Card title="Where it lives" icon={Laptop} tone="primary">
        <p className="opt-line">
          {syncOn
            ? 'In this Chrome profile, and a copy on the sync server you chose.'
            : 'Only in this Chrome profile, on this device.'}
        </p>
        <ul className="opt-tiles opt-tiles--small">
          <li>
            <a href="#backup" className="opt-tile" aria-label="Backup, take a copy">
              <ArtTile icon={Archive} tone="success" size="lg" />
              <span className="opt-tile__label">Backup</span>
              <span className="opt-tile__status">Take a copy</span>
            </a>
          </li>
          <li>
            <a href="#storage" className="opt-tile" aria-label="Storage, space used">
              <ArtTile icon={HardDrive} tone="warning" size="lg" />
              <span className="opt-tile__label">Storage</span>
              <span className="opt-tile__status">Space used</span>
            </a>
          </li>
          {syncOn ? (
            <li>
              <a href="#sync" className="opt-tile" aria-label="Sync, server copy">
                <ArtTile icon={Server} tone="primary" size="lg" />
                <span className="opt-tile__label">Sync</span>
                <span className="opt-tile__status">Server copy</span>
              </a>
            </li>
          ) : null}
        </ul>
      </Card>
      <DeleteData syncOn={syncOn} />
    </div>
  );
}
