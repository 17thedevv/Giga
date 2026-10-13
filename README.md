# Giga

**Giga** is an AI-powered web application with two independent experiences: conversational assistance and an agentic workspace.

## Overview

- **GigaChat:** Multi-turn AI conversations with streamed responses, persistent history and planned user-controlled Hybrid Memory/RAG.
- **GigaAgent:** A general-purpose tool-using assistant that plans tasks, creates/edits files, builds/tests inside an isolated workspace runtime, verifies outcomes and delivers artifacts. Git and GitHub are optional integrations, not required for tasks or completion.

The goal is observable, controllable AI work. Users can review plans, activities, files, checks and artifacts; consequential external actions require explicit scoped approval.

## Technology

Giga is TypeScript-first, with a React/Vite frontend, Hono API and PostgreSQL for durable metadata. The proposed Agent execution runtime is separately sandboxed; untrusted code must never run in the API host process.

## Status

**Early development.** Authentication and frontend scaffolding exist. Real autonomous Agent execution, isolated sandbox and GigaChat Memory/RAG have not been implemented yet. See `docs/README.md` for draft specifications.
