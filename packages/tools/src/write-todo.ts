import type { WriteTodoInput, WriteTodoOutput } from "@beam-me-up/core";
import { renderTodoMarkdown, shipChecklist } from "@beam-me-up/templates";

/**
 * writeTodo - build TODO.md + the ship checklist from the deploy outcome.
 *
 * Pure function: derives the standard ship checklist for the given input, then
 * renders the TODO.md markdown (Manual setup / Security follow-ups / Ship
 * checklist / Operate) around it.
 */
export function writeTodo(input: WriteTodoInput): WriteTodoOutput {
  const checklist = shipChecklist(input);
  const todoMarkdown = renderTodoMarkdown(input, checklist);

  return {
    todoMarkdown,
    shipChecklist: checklist,
  };
}
