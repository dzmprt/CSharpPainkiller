# Change Log

All notable changes to the "csharppainkiller" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.4]

### Added

- **Generate DTO with MapFrom** — creates a DTO file with matching public properties and a static `MapFrom{SourceType}` factory method. Available from the Explorer context menu on `.cs` files and as an editor code action on a type name
- **Generate FluentValidation Validator** — scaffolds `AbstractValidator<T>` with rules inferred from property types (strings, numbers, dates, enums, collections, etc.). Available from the Explorer context menu on `.cs` files and as an editor code action on a type name
- **Extract Type to File** — quick fix code action that moves a type from a multi-type file into its own `{TypeName}.cs` file (class, struct, record, record struct, enum, interface; partial types are excluded)

### Changed

- **MapTo / MapFrom** methods are now `static` with type-specific names (`MapTo{TargetType}`, `MapFrom{TargetType}`) instead of generic `MapTo` / `MapFrom`
- Editor code actions for mapping, DTO, and FluentValidation generation now target the type under the cursor, not only the primary type in the file
- **Adjust Namespaces** — `using` directives are added only when a file references a moved type; stale `using` directives are removed only for orphaned old namespaces. Type names inside `using` and `namespace` lines are no longer counted as type usage

### Fixed

- **Extract Interface** context menu entry is shown only for `.cs` files, not folders
- Explorer context menu order for **Go To Handler** and **Generate Handler** on mediator files
- **Go To Handler / Generate Handler** — correctly parses nested generic return types (e.g. `IRequest<List<Author>>`) when detecting MediatR/MitMediator request files
- **MitMediator Handler** — void requests now generate `IRequestHandler<TRequest>` with `ValueTask<Unit> HandleAsync(...)` instead of plain `ValueTask`
- **MitMediator Request and Handler** — void request/handler pairs no longer use `Unit` as a return type where MitMediator expects a non-generic `IRequest` handler
- **Adjust Namespaces** — redundant `using` directives for the file's own namespace are removed when the namespace already matches
- **Rename File By Type** — `record struct` types are parsed correctly; block-scoped namespaces with nested braces are handled; files with multiple public types (e.g. `record struct` + `class`) are treated as ambiguous

## [0.0.3]

- Added **Entity Framework CMD** commands — Add Migration, Remove Migration, Update Database, List Migrations, Script Migration via `dotnet ef` CLI. Added **Entity Framework CMD** submenu to `.csproj` file context menu
- Custom color for C# project folders

## [0.0.2]

- Added **.NET Project Creation** (`.NET NEW`) — dynamic template scaffolding from `dotnet new list`
- Real-time diagnostics have been removed due to performance issues. This may be added in the future
- Changed sort usings logic

## [0.0.1]

Initial release with:
- C# type creation (class, record, struct, enum, interface, record struct)
- Namespace adjustment for files and folders with automatic `using` directive updates
- File renaming based on the contained C# type name
- Sort usings, extract interface, generate MapTo/MapFrom mapping methods
- ASP.NET templates (Empty Controller, EF CRUD Controller, Empty Minimal API, EF CRUD Minimal API)
- MediatR and MitMediator templates (Request, Handler, Notification, PipelineBehavior)
- EF Core Entity Configuration generation
- Real-time diagnostics (wrong namespace, wrong filename, unsorted usings, mixed-language identifiers)
- Generate Request and handler for MediatR and MitMediator request files
- Go To Handler navigation for MediatR and MitMediator
