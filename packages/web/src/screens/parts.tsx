/**
 * The Parts Catalog browser (frontend spec section 5), for each Ruleset the
 * server hosts (`?ruleset=r1`, the newest by default): every Chassis drawn
 * bare, with its Slots and stats, and every Component by kind, drawn when it
 * goes in a Slot, with its cost, the Slots it fits and its stats.
 */

import type { Schema } from "../api/client.js";
import { bareChassisParts, cachedPartsCatalog, componentsByKind, kindText, partsRoute, statText, type Chassis, type Component } from "../browse.js";
import { BotPreview, ComponentPreview } from "../draw/preview.js";
import { problemText } from "../games.js";
import { Link, useLoad, useRoute, useServices } from "../hooks.js";
import type { PartsCatalog } from "../replays.js";

export function PartsScreen() {
  const { api } = useServices();
  const route = useRoute();
  const rulesets = useLoad(() => api.request<Schema<"RulesetList">>("GET", "/rulesets"), "rulesets");
  if (rulesets.status === "loading") return <p>Loading…</p>;
  if (rulesets.status === "failed") {
    return (
      <>
        <h2>Parts Catalog</h2>
        <p className="error" role="alert">
          {problemText(rulesets.error)}
        </p>
      </>
    );
  }
  const versions = rulesets.value.rulesets.map((r) => r.version);
  // The list is oldest first, so the newest Ruleset is shown unless another is asked for.
  const asked = route.search.get("ruleset");
  const version = asked ?? versions.at(-1);
  return (
    <>
      <h2>Parts Catalog</h2>
      <nav className="tabs" aria-label="Rulesets">
        {versions.map((v) => (
          <Link key={v} to={partsRoute(v)} className={v === version ? "current" : undefined}>
            Ruleset {v}
          </Link>
        ))}
      </nav>
      {version === undefined ? (
        <p>This server hosts no Rulesets.</p>
      ) : !versions.includes(version) ? (
        <p className="error" role="alert">
          This server does not host Ruleset {version}.
        </p>
      ) : (
        <CatalogLoader key={version} version={version} />
      )}
    </>
  );
}

function CatalogLoader({ version }: { readonly version: string }) {
  const { api } = useServices();
  const catalog = useLoad(() => cachedPartsCatalog(api, version), version);
  if (catalog.status === "loading") return <p>Loading…</p>;
  if (catalog.status === "failed") {
    return (
      <p className="error" role="alert">
        {problemText(catalog.error)}
      </p>
    );
  }
  return <CatalogView catalog={catalog.value} />;
}

export function CatalogView({ catalog }: { readonly catalog: PartsCatalog }) {
  return (
    <div className="catalog">
      <section aria-labelledby="chassis-heading">
        <h3 id="chassis-heading">Chassis</h3>
        <ul className="cards">
          {catalog.chassis.map((chassis) => (
            <ChassisCard key={chassis.id} catalog={catalog} chassis={chassis} />
          ))}
        </ul>
      </section>
      {componentsByKind(catalog).map(([kind, components]) => (
        <section key={kind} aria-labelledby={`kind-${kind}-heading`}>
          <h3 id={`kind-${kind}-heading`}>{kindText(kind)}</h3>
          <table className="list parts">
            <thead>
              <tr>
                <th />
                <th>Component</th>
                <th>Cost</th>
                <th>{catalog.componentKinds[kind]?.mount === "side" ? "Mount" : "Fits"}</th>
                <th>Stats</th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <ComponentRow key={component.id} catalog={catalog} component={component} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function ChassisCard({ catalog, chassis }: { readonly catalog: PartsCatalog; readonly chassis: Chassis }) {
  const parts = bareChassisParts(catalog, chassis);
  return (
    <li>
      {parts === undefined ? null : <BotPreview parts={parts} label={`${chassis.name} preview`} />}
      <h4>{chassis.name}</h4>
      <p>{String(chassis.cost)} points</p>
      <p className="muted">{chassis.description}</p>
      <Stats stats={chassis.stats} />
      <p>
        Slots: {chassis.slots.length === 0 ? "none" : chassis.slots.map((slot) => `${slot.id} (${slot.type})`).join(", ")}
      </p>
    </li>
  );
}

function ComponentRow({ catalog, component }: { readonly catalog: PartsCatalog; readonly component: Component }) {
  const side = catalog.componentKinds[component.kind]?.mount === "side";
  return (
    <tr>
      <td>{side ? null : <ComponentPreview component={component} label={`${component.name} preview`} />}</td>
      <td>
        <strong>{component.name}</strong>
        <br />
        <span className="muted">{component.description}</span>
      </td>
      <td data-label="Cost">{String(component.cost)}</td>
      <td data-label={side ? "Mount" : "Fits"}>{side ? "per side" : component.slotTypes.join(", ")}</td>
      <td>
        <Stats stats={component.stats} />
      </td>
    </tr>
  );
}

function Stats({ stats }: { readonly stats: Chassis["stats"] }) {
  return (
    <dl className="stats">
      {Object.entries(stats).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{statText(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
