import { useState } from 'react';
import { useSavedPlaces, type SavedPlace } from '@/store/savedPlaces';

const ICONS = ['🏠', '💼', '🏫', '🕌', '🏥', '🛒', '🏖️', '📍'];

export function Saved({ onClose, onAdd }: { onClose: () => void; onAdd: () => void }) {
  const places = useSavedPlaces((s) => s.places);
  const rename = useSavedPlaces((s) => s.rename);
  const remove = useSavedPlaces((s) => s.remove);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink-100">Saved places</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-10 place-items-center rounded-full text-ink-500 active:bg-white/10"
        >
          <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
            <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
          </svg>
        </button>
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="min-h-11 w-full rounded-xl border border-dashed border-white/20 text-sm font-medium text-brand-400 active:bg-white/5"
      >
        + Add a place
      </button>

      {places.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-ink-500">
          Save the places you travel to often — they show up on the home screen and at the top of
          search. Saved places stay on this device.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-ink-900">
          {places.map((p) =>
            editing === p.id ? (
              <EditRow
                key={p.id}
                place={p}
                onSave={(name, icon) => {
                  rename(p.id, name, icon);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                onDelete={() => {
                  remove(p.id);
                  setEditing(null);
                }}
              />
            ) : (
              <div
                key={p.id}
                className="flex min-h-14 items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-0"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-800 text-lg">
                  {p.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-100">{p.name}</span>
                <button
                  type="button"
                  onClick={() => setEditing(p.id)}
                  className="min-h-10 shrink-0 rounded-lg px-3 text-xs font-medium text-brand-400 active:bg-white/5"
                >
                  Edit
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function EditRow({
  place,
  onSave,
  onCancel,
  onDelete,
}: {
  place: SavedPlace;
  onSave: (name: string, icon: string) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(place.name);
  const [icon, setIcon] = useState(place.icon);

  return (
    <div className="space-y-3 border-b border-white/5 p-3 last:border-0">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-11 w-full rounded-lg bg-ink-800 px-3 text-sm text-ink-100 outline-none focus:ring-2 focus:ring-brand-500"
        placeholder="Name"
      />
      <div className="flex flex-wrap gap-1.5">
        {ICONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => setIcon(emoji)}
            aria-pressed={icon === emoji}
            className={`grid size-10 place-items-center rounded-lg text-lg ${
              icon === emoji ? 'bg-brand-500/25 ring-1 ring-brand-500' : 'bg-ink-800'
            }`}
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDelete}
          className="min-h-10 rounded-lg px-3 text-xs font-medium text-red-400 active:bg-red-500/10"
        >
          Delete
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="min-h-10 rounded-lg px-3 text-xs font-medium text-ink-300 active:bg-white/5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(name.trim() || place.name, icon)}
          className="min-h-10 rounded-lg bg-brand-500 px-4 text-xs font-semibold text-white active:bg-brand-400"
        >
          Save
        </button>
      </div>
    </div>
  );
}
