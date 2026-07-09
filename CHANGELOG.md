# Change Log

All notable changes to the "csharppainkiller" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.9]

### Changed

- **Solution Structure folder deletion** — deleting a solution folder now asks whether its non-empty physical folder should also be removed, with the option to keep it
- **Wrong filename diagnostics** — enabled by default for open C# files

### Fixed
- **Solution Structure `.sln/.slnx` management** — fixed nested solution folders

## [0.0.8]

### Added

- **C# Analyze Solution** — run a one-off, cancellable workspace scan and choose which analyzers to run for that scan
- **Diagnostics for open files** — real-time diagnostics for open `.cs` files, controlled by the `csharppainkiller.diagnostics.*` settings
- **Duplicate type diagnostics** — warn when the same type name is declared in more than one file within the same project
- **NuGet package update checks** — Solution Structure can check installed packages for newer stable versions, update one package, or update all outdated packages in a project
- **NuGet dependency display** — installed packages can show their declared dependencies in the Solution Structure tree when NuGet metadata is available
- **NuGet vulnerability display** — Solution Structure shows known vulnerable packages for a solution and can open the advisory link when NuGet provides one

### Changed

- **Solution Structure NuGet checks** — package update and vulnerability checks run automatically in the background when the Solution Structure view opens, and manual checks now report partial/offline failures instead of treating them as up to date
- **Solution Structure project labels** — project nodes now include the configured C# language version when it is present in the project file
- **Sort Usings** — the command and the unsorted-usings diagnostic now use the same order: global usings, `System.*`, other namespaces, static usings, then alias usings; duplicate using directives are removed by the command
- **Extract Type to File** — the quick fix is offered only for extra types in a multi-type file, not for the type that already matches the current file name

### Fixed

- **Diagnostics performance** — namespace diagnostics avoid repeated full-workspace `.csproj` scans while editing open files

## [0.0.7]

### Fixed

- **Solution Structure `.slnx` folders** — solution folders were written as `<Folder Name="src" />` instead of the correct `<Folder Name="/src/" />` (leading and trailing slashes required by the `.slnx` format)

## [0.0.6]

### Added

- **NuGet Package Management** — add/remove NuGet packages from the Solution Structure panel. Search across `nuget.config` sources (falls back to nuget.org), toggle pre-release, pick a version

### Changed

- **Solution Structure** — project nodes show target framework (e.g. `net8.0`) instead of generic type labels

### Fixed

- Extension icon path typo (`logo.png.png` → `logo.png`)

## [0.0.5]

### Added

- **Solution Structure (beta)** — new Explorer sidebar panel that displays the logical structure of `.sln` / `.slnx` solution files. Supports creating and deleting solution folders, adding/removing projects, and managing project references directly from the tree. Controlled by the `csharppainkiller.solutionStructure.show` setting
- **Sync Type and File Name** — automatically renames the file when the single public type inside it is renamed on save, and can rename the type to match the file name when a `.cs` file is renamed
- **Editor right-click context menu** — C# Painkiller actions (Go To Handler, Generate MapTo, Generate MapFrom, Generate DTO, Generate FluentValidation Validator) are now available in the editor context menu
- **Settings to show/hide feature groups** — new boolean settings to control which generators appear in context menus and code actions: `csharppainkiller.templates.showMediatR`, `showMitMediator`, `showAspNet`, `showEfCore`, `showFluentValidation`
- **New icons** — dedicated icons for solution files and test project folders; updated folder icons for ASP.NET and default project types
- **Extended activation** — extension now activates when a workspace contains `.csproj`, `.sln`, or `.slnx` files in addition to C# language activation

### Fixed

- **MediatR and MitMediator handlers** — generated `Handle` / `HandleAsync` methods now include the `async` keyword
- **Create .NET Project** — prevents project creation inside an existing project folder; project creation from the Solution Structure tree correctly adds the new project to the solution
- **Rename File By Type with `internal record struct`** — files containing `internal record struct TypeName` were incorrectly renamed to `struct.cs` instead of `TypeName.cs` due to regex backtracking that captured the keyword `struct` as the type name

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
