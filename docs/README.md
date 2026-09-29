# Documentation

The [root README](../README.md) covers what RetailStore_2n is and how to run it.
Everything below is the detail deliberately kept out of it.

## Start here

**New to the codebase?** Read [architecture/README.md](architecture/README.md) —
one diagram and the seven ideas that explain most of the code — then skim the
[decision records](adr/README.md).

**Adding a feature?** [architecture/lld.md](architecture/lld.md) for module
boundaries and conventions, [architecture/data-model.md](architecture/data-model.md)
for the schema and its invariants.

**Integrating against the API?** [api.md](api.md), or import the
[Postman collection](postman/README.md) to try every endpoint.

**Deploying it?** [k8s/README.md](../k8s/README.md) — the manifests, and an
explicit list of what is verified on kind versus what has never run on a real
cluster.

**Wondering why something is built a certain way?** [adr/](adr/README.md). If the
answer isn't there and the decision wasn't obvious, that's a gap worth filling.

**Wondering what a feature cost to build?** [plans/](plans/). A plan is written
before the work and says so at the top; once its phases land, each one gains a
note recording what was met, what was met only in part, and what came out of
building it that planning missed. Both plans here have landed, and they are kept
for those notes — the reasoning is the point, not the schedule.

## Contents

```
docs/
├── architecture/
│   ├── README.md        Overview and orientation
│   ├── hld.md           Context, containers, request lifecycle, security model
│   ├── lld.md           Modules, flows, sequence diagrams, conventions
│   └── data-model.md    ER diagram, tables, invariants, migrations
├── api.md               Endpoint reference
├── postman/             Postman collection and local environment for every endpoint
├── adr/                 Numbered decision records
└── plans/               Multi-phase work: the plan, then what each phase cost
```

## Keeping this honest

Documentation that describes intentions rather than the code is worse than none,
because it is believed. Two habits keep it usable:

- **State what is not built.** Every document marks stubs and gaps explicitly.
  The seven provider seams and what each stub does instead of the real thing are
  in [hld.md §6](architecture/hld.md#6-provider-seams), and known limitations in
  [§7](architecture/hld.md#7-known-limitations). Where something is built but
  has never run against the real provider — payouts, today — that is said in
  those words rather than counted as done.
- **Update docs in the same change as the code.** A schema change touches
  `data-model.md`; a new endpoint touches `api.md`; a non-obvious choice gets an
  ADR. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Diagrams are [Mermaid](https://mermaid.js.org) in fenced blocks, which GitHub
renders natively — so they are diffable text, not binary images that drift out
of date.
