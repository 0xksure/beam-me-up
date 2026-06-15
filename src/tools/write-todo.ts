import type { WriteTodoInput, WriteTodoOutput } from "../schemas.js";
import { renderTodoMarkdown, shipChecklist } from "../templates/todo.js";

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
