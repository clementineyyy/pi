# Personal Agent Product

This context defines product-facing language for the PC-first personal agent and its integrations.

## Capabilities and catalogs

**Agent core**:
The personal agent's minimal product layer for conversation and the agent loop, task and session management, persistence and memory, and the general mechanisms for discovering, invoking, configuring, and governing capabilities.
_Avoid_: base plugin

**Harness**:
The outer runtime that resolves model requests, applies parameter and permission rules, executes capabilities, and returns results; the model interprets, selects, and generates, while the harness performs operations.
_Avoid_: model runtime

**Capability**:
A reusable unit of functionality the agent can invoke, implemented as a tool, plugin, extension, MCP integration, or skill. It has a stable unique ID separate from its display name and can be referenced by multiple capability packages.
_Avoid_: feature

**Capability package**:
A user-installable set of capabilities needed for one user-facing function. Each package has a stable unique ID separate from its display name, and may reference capabilities shared with other packages. It is enabled after installation subject to required source authorization or missing user information, and may include a dedicated settings page or interface.
_Avoid_: tool bundle, MCP package

**Capability registration**:
The post-approval catalog step that validates a package's source and manifest, records it, and assigns stable IDs; metadata may be checked before approval without registering the package.

**Capability installation**:
The user-approved retrieval of a package and its dependencies, including only the package-declared installation and verification steps; installation does not execute task functionality.

**Capability invocation**:
Harness-mediated execution of an installed capability after a user selects it or the agent selects it for a specific task.

**Capability operation declaration**:
A capability's baseline declaration of the operations it needs; it informs effective permissions, which the product determines from applicable rules and user settings or parameters.
_Avoid_: permission grant

**Capability package search**:
A core discovery operation that finds installed user-facing capability packages when the agent needs a workflow for a task.

**Capability search**:
A core discovery operation that finds installed reusable capabilities the agent can call after it understands the task workflow, including capabilities not fully visible in the prompt catalog.

**Capability catalog**:
The unified UI directory for browsing capability packages from product-maintainer-selected external markets and approving their installation.

**Market adapter**:
A source-specific integration that presents an external market's package listings and installation source through the capability catalog.

## Sources and authority

**External source**:
A service, application, or public web source from which the personal agent receives information or performs an operation.

**Connected source**:
An external source made available to the personal agent through an API, supported connector, or user-authenticated session.

**Source authorization**:
The API grant or authenticated session that sets the maximum data and operations technically available from a connected source.
_Avoid_: execution permission

**Execution permission**:
A product rule that defines which operations a function may perform autonomously and which require user approval.
_Avoid_: data access permission, authorization
