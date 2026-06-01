# Change Log

All notable changes to the "csharppainkiller" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
