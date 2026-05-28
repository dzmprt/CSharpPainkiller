C# Painkiller

Smart file creation, code generation, project creation, namespace management and more for C#.

![License](https://img.shields.io/github/license/dzmprt/CSharpPainkiller)

[GitHub repository](https://github.com/dzmprt/CSharpPainkiller)

[VisualStudio Marketplace](https://marketplace.visualstudio.com/items?itemName=DzmitryPratsko.csharppainkiller)

</div>

---

## Requirements

- **VS Code 1.92.0+**

## Table of Contents

- [Features](#features)
  - [Create C# Types](#create-c-types)
  - [Adjust Namespaces](#adjust-namespaces)
  - [Rename File By Type](#rename-file-by-type)
  - [Generate Mapping Methods](#generate-mapping-methods)
  - [Sort Usings](#sort-usings)
  - [Extract Interface](#extract-interface)
  - [.NET Project Creation](#net-project-creation)
  - [ASP.NET Templates](#aspnet-templates)
  - [MediatR and MitMediator templates](#mediatr-and-mitmediator-templates)
  - [EF Core](#ef-core)
  - [Go To Handler](#go-to-handler)
- [Issues](#issues)
- [Release Notes](#release-notes)

## Features

### Create C# Types

Quickly scaffold new C# type files with auto-detected namespaces. Right-click a **folder** in the Explorer → **C# Create**.

![Create C# Type demo](images/CreateFile.gif)

### Adjust Namespaces

Fix namespace declarations across one file or an entire folder in a single action. Right-click any `.cs` file or folder → **C# Refactor → C# Adjust Namespaces**.

![Adjust Namespaces demo](images/AdjustNamespacesDemo.gif)

### Rename File By Type

Rename `.cs` files to match the C# type they contain. Right-click a file or folder → **C# Refactor → C# Rename File By Type**.

![Rename File By Type demo](images/RenameFile.gif)

### Generate Mapping Methods

Generate `MapTo` / `MapFrom` boilerplate for mapping between types. Available in the **C# Refactor** submenu.

![Generate Mapping demo](images/GenerateMappingDemo.gif)

### Sort Usings

Alphabetically sort `using` directives in a `.cs` file or across an entire folder. Right-click → **C# Refactor → C# Sort Usings**.

### Extract Interface

Generate an interface from a class definition in one click. Right-click a `.cs` file → **C# Refactor → C# Extract Interface**.

### .NET Project Creation

Scaffold new .NET projects using dynamic templates from `dotnet new list`. Right-click a **folder** in the Explorer → **.NET NEW**. The extension dynamically fetches available .NET templates and registers them as commands at startup, allowing you to create any project type supported by the .NET SDK.

![ASP.NET Templates demo](images/NETProjectCreation.gif)

### ASP.NET Templates

Scaffold ASP.NET controllers and Minimal API endpoints. Right-click a folder → **C# Generator → ASP.NET**.

![ASP.NET Templates demo](images/AspnetTemplatesGenerate.gif)

| Template | Description |
|----------|-------------|
| **Empty Controller** | Bare-bones `[ApiController]` class |
| **EF CRUD Controller** | Full CRUD controller wired to `DbContext` |
| **Empty Minimal API** | Minimal API endpoint group stub |
| **EF CRUD Minimal API** | Full CRUD Minimal API wired to `DbContext` |


### MediatR and MitMediator templates

Generate requests, handlers, notifications, and pipeline behaviors. Right-click a folder → **C# Generator → MediatR/MitMediator**. It is not necessary to enter the full name of the request, if it is a base request like "get, create, delete, update or other" the extension will automatically substitute the name and determine whether it is a command or a query.

![MediatR Templates demo](images/MediatrTemplatesDemo.gif)

| Template | Description |
|----------|-------------|
| **Request and Handler** | `IRequest` + `IRequestHandler` pair |
| **Request** | `IRequest` only |
| **RequestHandler** | `IRequestHandler` only |
| **Notification and Handler** | `INotification` + `INotificationHandler` pair |
| **Notification** | `INotification` only |
| **NotificationHandler** | `INotificationHandler` only |
| **Empty PipelineBehavior** | Blank `IPipelineBehavior` |
| **FluentValidation PipelineBehavior** | Validation behavior using FluentValidation |

### EF Core

Scaffold Entity Framework Core entity configurations. Right-click a folder → **C# Generator → EF Core**, or right-click a `.cs` entity file directly.

![EF Core demo](images/efcore.gif)

### Go To Handler

Navigate between a MediatR/MitMediator request file and its handler.

![Go To Handler demo](images/goToHandler.gif)

## Issues

- If you find a bug please report it on [GitHub issues](https://github.com/dzmprt/CSharpPainkiller/issues)

## Release Notes

### 0.0.2

- Added **.NET Project Creation** (`.NET NEW`) — dynamic template scaffolding from `dotnet new list`
- Real-time diagnostics have been removed due to performance issues. This may be added in the future
- Changed sort usings logic

### 0.0.1

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
