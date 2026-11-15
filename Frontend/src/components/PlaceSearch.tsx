import {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

export type Place = {
  id: string
  name: string
  description: string
  longitude: number
  latitude: number
  kind: string
  extent?: [number, number, number, number]
}

type PhotonFeature = {
  geometry?: {
    coordinates?: number[]
  }
  properties?: {
    name?: string
    city?: string
    state?: string
    country?: string
    osm_type?: string
    osm_id?: number
    osm_value?: string
    type?: string
    extent?: number[]
  }
}

const normalizeName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()

// Translate complete Romanian country names for the geocoder.
// Examples: Grecia -> Greece, România -> Romania.
const countryNames = new Map<string, string>()

const romanianNames = new Intl.DisplayNames(
  ['ro'],
  { type: 'region' }
)

const englishNames = new Intl.DisplayNames(
  ['en'],
  { type: 'region' }
)

for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b)
    const ro = romanianNames.of(code)
    const en = englishNames.of(code)

    if (ro && en && ro !== code && en !== code) {
      countryNames.set(normalizeName(ro), en)
    }
  }
}

function parsePlaces(
  features: PhotonFeature[]
): Place[] {
  const unique = new Map<string, Place>()

  for (const feature of features) {
    const p = feature.properties
    const xy = feature.geometry?.coordinates

    if (
      !p?.name ||
      !xy ||
      !Number.isFinite(xy[0]) ||
      !Number.isFinite(xy[1])
    ) {
      continue
    }

    if (
      Math.abs(xy[0]) > 180 ||
      Math.abs(xy[1]) > 90
    ) {
      continue
    }

    const description = [
      ...new Set([p.city, p.state, p.country]),
    ]
      .filter((text) => text && text !== p.name)
      .join(', ')

    const id =
      `${p.osm_type || ''}-${p.osm_id || ''}-` +
      `${xy[0]}-${xy[1]}`

    const extent =
      p.extent?.length === 4 &&
      p.extent.every(Number.isFinite)
        ? (p.extent as [
            number,
            number,
            number,
            number,
          ])
        : undefined

    unique.set(id, {
      id,
      name: p.name,
      description:
        description || 'Explore this location',
      longitude: xy[0],
      latitude: xy[1],
      kind: p.type || p.osm_value || 'place',
      extent,
    })
  }

  return [...unique.values()].slice(0, 6)
}

export default function PlaceSearch({
  disabled,
  onSelect,
}: {
  disabled: boolean
  onSelect: (place: Place) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Place[]>([])
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState(false)

  const cache = useRef(
    new Map<string, Place[]>()
  )

  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()

  useEffect(() => {
    const term = query.trim()

    if (
      term.length < 2 ||
      disabled ||
      chosen
    ) {
      return
    }

    const controller = new AbortController()

    const timer = setTimeout(async () => {
      try {
        setLoading(true)

        const key = term.toLocaleLowerCase()
        let places = cache.current.get(key)

        if (!places) {
          const searchTerm =
            countryNames.get(normalizeName(term)) ||
            term

          const params = new URLSearchParams({
            q: searchTerm,
            limit: '6',
            lang: 'en',
          })

          const response = await fetch(
            `https://photon.komoot.io/api/?${params}`,
            {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(8000),
              ]),
            }
          )

          if (!response.ok) {
            throw new Error(
              'Search service unavailable.'
            )
          }

          const data = (await response.json()) as {
            features?: PhotonFeature[]
          }

          places = parsePlaces(
            Array.isArray(data.features)
              ? data.features
              : []
          )

          if (controller.signal.aborted) return

          if (cache.current.size >= 60) {
            cache.current.clear()
          }

          cache.current.set(key, places)
        }

        if (controller.signal.aborted) return

        setItems(places)
        setActive(-1)
        setLoading(false)
      } catch {
        if (controller.signal.aborted) return

        setLoading(false)

        setError(
          'Search is temporarily unavailable. ' +
            'You can still navigate the globe manually.'
        )
      }
    }, 450)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, disabled, chosen])

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }

    document.addEventListener(
      'pointerdown',
      outside
    )

    return () => {
      document.removeEventListener(
        'pointerdown',
        outside
      )
    }
  }, [])

  function change(value: string) {
    setQuery(value)
    setChosen(false)
    setItems([])
    setActive(-1)
    setError('')
    setLoading(value.trim().length >= 2)
    setOpen(true)
  }

  function choose(place: Place) {
    setChosen(true)
    setQuery(place.name)
    setOpen(false)
    setLoading(false)

    onSelect(place)
    input.current?.blur()
  }

  const expanded =
    open &&
    !disabled &&
    !chosen &&
    query.trim().length > 0

  return (
    <div ref={root} className="place-search">
      <div
        className={`search-field ${
          expanded ? 'search-field--open' : ''
        }`}
      >
        <svg
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle
            cx="10.5"
            cy="10.5"
            r="6.5"
          />
          <path d="m16 16 4 4" />
        </svg>

        <input
          ref={input}
          value={query}
          disabled={disabled}
          role="combobox"
          aria-label="Search for a country, city or place"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={
            expanded && active >= 0
              ? `${listId}-${active}`
              : undefined
          }
          placeholder="Search a country, city or place..."
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            change(event.target.value)
          }
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setOpen(false)
              return
            }

            if (
              event.key === 'ArrowDown' ||
              event.key === 'ArrowUp'
            ) {
              event.preventDefault()
              setOpen(true)

              if (items.length) {
                setActive((previous) =>
                  event.key === 'ArrowDown'
                    ? (previous + 1) % items.length
                    : previous <= 0
                      ? items.length - 1
                      : previous - 1
                )
              }
            }

            if (
              event.key === 'Enter' &&
              items.length &&
              expanded
            ) {
              event.preventDefault()

              choose(
                items[active >= 0 ? active : 0]
              )
            }
          }}
        />

        {query && !disabled ? (
          <button
            className="search-clear"
            type="button"
            aria-label="Clear search"
            onClick={() => {
              change('')
              input.current?.focus()
            }}
          >
            ×
          </button>
        ) : (
          <span
            className="search-shortcut"
            aria-hidden="true"
          >
            ⌕
          </span>
        )}
      </div>

      {expanded && (
        <div className="search-dropdown">
          <div className="search-caption">
            GO TO A LOCATION
          </div>

          <div
            id={listId}
            role="listbox"
            aria-label="Location suggestions"
          >
            {items.map((place, index) => (
              <button
                key={place.id}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={active === index}
                className={`search-option ${
                  active === index
                    ? 'search-option--active'
                    : ''
                }`}
                onMouseEnter={() =>
                  setActive(index)
                }
                onClick={() => choose(place)}
              >
                <span
                  className="place-pin"
                  aria-hidden="true"
                >
                  ↗
                </span>

                <span>
                  <strong>{place.name}</strong>
                  <small>
                    {place.description}
                  </small>
                </span>

                <span className="place-kind">
                  {place.kind}
                </span>
              </button>
            ))}
          </div>

          {!items.length && (
            <p
              className="search-message"
              role="status"
            >
              {query.trim().length < 2
                ? 'Type at least two characters.'
                : loading
                  ? 'Searching places...'
                  : error ||
                    'No matching places. Try another spelling.'}
            </p>
          )}

          <a
            className="search-attribution"
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            Place search: Photon · © OpenStreetMap
            contributors
          </a>
        </div>
      )}
    </div>
  )
}