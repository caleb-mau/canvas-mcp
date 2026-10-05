import { acceptedContent, inputRequired, inputResponse, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CanvasApiError, CanvasClient, type HttpMethod, type Query } from "./canvas";
import { confirmationRequired, loadConfig, redactedConfig } from "./config";

const id = z.union([z.string(), z.number()]).transform(String);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const querySchema = z.record(z.string(), z.union([scalar, z.array(scalar)])).optional();

const confirmationSchema = z.object({
  confirm: z.boolean().meta({ title: "Confirm Canvas change" }),
});

function compactPreview(value: unknown, maxLength = 420): string {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(empty)";
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

async function assignmentTitle(
  client: CanvasClient,
  courseId: string,
  assignmentId: string,
): Promise<string> {
  try {
    const assignment = await client.get<Record<string, unknown>>(
      "/api/v1/courses/" + encodeURIComponent(courseId) +
      "/assignments/" + encodeURIComponent(assignmentId),
    );
    return typeof assignment.data.name === "string"
      ? assignment.data.name
      : "assignment " + assignmentId;
  } catch {
    return "assignment " + assignmentId;
  }
}

async function confirmationMessage(
  name: string,
  args: any,
  client: CanvasClient,
): Promise<string | null> {
  switch (name) {
    case "canvas_submit_text": {
      const title = await assignmentTitle(client, args.course_id, args.assignment_id);
      return [
        'Submit the text response to "' + title + '" in Canvas?',
        "This will turn in the assignment. Drafting, reviewing, or editing alone does not submit anything.",
        "Preview: " + compactPreview(args.body),
      ].join("\n\n");
    }
    case "canvas_submit_url": {
      const title = await assignmentTitle(client, args.course_id, args.assignment_id);
      return [
        'Submit this URL to "' + title + '" in Canvas?',
        "This will turn in the assignment.",
        "URL: " + args.url,
      ].join("\n\n");
    }
    case "canvas_submit_file": {
      const title = await assignmentTitle(client, args.course_id, args.assignment_id);
      return [
        'Upload and submit this file to "' + title + '" in Canvas?',
        "No file will be uploaded and the assignment will not be submitted unless you confirm.",
        "File: " + args.file_path,
      ].join("\n\n");
    }
    case "canvas_post_discussion_entry":
      return [
        "Post this discussion entry to Canvas?",
        "Preview: " + compactPreview(args.message),
      ].join("\n\n");
    case "canvas_reply_to_discussion":
      return [
        "Post this discussion reply to Canvas?",
        "Preview: " + compactPreview(args.message),
      ].join("\n\n");
    case "canvas_send_message":
      return [
        "Send this Canvas Inbox message?",
        args.subject ? "Subject: " + args.subject : "No subject",
        "Preview: " + compactPreview(args.body),
      ].join("\n\n");
    case "canvas_teacher_grade_submission": {
      const title = await assignmentTitle(client, args.course_id, args.assignment_id);
      const changes = [
        args.posted_grade !== undefined ? "grade: " + args.posted_grade : null,
        args.excuse !== undefined ? "excused: " + args.excuse : null,
        args.late_policy_status !== undefined ? "late status: " + args.late_policy_status : null,
        args.comment !== undefined ? "comment: " + compactPreview(args.comment, 240) : null,
      ].filter(Boolean).join("\n");
      return [
        "Apply these changes to " + args.student_ref + ' for "' + title + '"?',
        changes || "Submission metadata will be changed.",
      ].join("\n\n");
    }
    case "canvas_teacher_message_student":
      return [
        "Send a Canvas Inbox message to " + args.student_ref + "?",
        args.subject ? "Subject: " + args.subject : "No subject",
        "Preview: " + compactPreview(args.body),
      ].join("\n\n");
    case "canvas_api":
      return args.method === "GET"
        ? null
        : [
            "Run raw Canvas mutation " + args.method + " " + args.path + "?",
            "This is a low level API call and may change Canvas data.",
          ].join("\n\n");
    default:
      return null;
  }
}

function cancelledConfirmation() {
  return ok({
    cancelled: true,
    changed_canvas: false,
    message: "Cancelled. Nothing was changed in Canvas.",
  });
}


function apiPath(...parts: Array<string | number>): string {
  return "/api/v1/" + parts.map((part) => encodeURIComponent(String(part))).join("/");
}

function ok(data: unknown, extra?: Record<string, unknown>) {
  const payload = extra ? { ...extra, data } : data;
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
  if (error instanceof CanvasApiError) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: error.message,
          status: error.status,
          details: error.details,
        }, null, 2),
      }],
    };
  }

  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error),
    }],
  };
}

function tool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodType,
  handler: (args: any, client: CanvasClient) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema }, async (args, ctx) => {
    try {
      const client = new CanvasClient(await loadConfig());
      const message = await confirmationMessage(name, args, client);

      if (message && confirmationRequired()) {
        const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");

        if (view.kind === "elicit") {
          if (view.action !== "accept") return cancelledConfirmation();

          const confirmed = acceptedContent(
            ctx.mcpReq.inputResponses,
            "confirm",
            confirmationSchema,
          );
          if (confirmed?.confirm !== true) return cancelledConfirmation();
        } else {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message,
                requestedSchema: confirmationSchema,
              }),
            },
          });
        }
      }

      return ok(await handler(args, client));
    } catch (error) {
      return fail(error);
    }
  });
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "canvas-mcp", version: "0.1.0" },
    {
      instructions:
        "Reading Canvas and drafting school work are nonmutating. Never infer permission to submit from requests such as draft, write, solve, complete, review, or help with an assignment. Only call a submission tool when the user explicitly asks to submit or turn in the work. Submission, grading, messages, discussion posts, and raw mutating Canvas API calls require an end user confirmation step by default. Never use canvas_api to bypass confirmation or teacher privacy protections.",
    },
  );

  server.registerTool(
    "canvas_status",
    {
      description: "Verify the Canvas connection and show local configuration with the access token redacted.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const config = await loadConfig();
        const client = new CanvasClient(config);
        const profile = await client.get("/api/v1/users/self/profile");
        return ok(profile.data, { connected: true, config: redactedConfig(config) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  tool(server, "canvas_get_profile", "Get the current Canvas user's profile.", z.object({}), async (_args, client) =>
    (await client.get("/api/v1/users/self/profile")).data,
  );

  tool(
    server,
    "canvas_list_courses",
    "List courses visible to the current Canvas user.",
    z.object({
      enrollment_state: z.string().optional(),
      enrollment_type: z.enum(["teacher", "student", "ta", "observer", "designer"]).optional(),
      include: z.array(z.string()).optional(),
      state: z.array(z.string()).optional(),
    }),
    async (args, client) => (await client.get("/api/v1/courses", {
      enrollment_state: args.enrollment_state,
      enrollment_type: args.enrollment_type,
      include: args.include,
      state: args.state,
      per_page: 100,
    }, true)).data,
  );

  tool(
    server,
    "canvas_get_course",
    "Get one Canvas course.",
    z.object({ course_id: id, include: z.array(z.string()).optional() }),
    async ({ course_id, include }, client) =>
      (await client.get(apiPath("courses", course_id), { include })).data,
  );

  tool(
    server,
    "canvas_list_assignments",
    "List assignments in a course including submission information by default.",
    z.object({
      course_id: id,
      bucket: z.enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"]).optional(),
      search_term: z.string().optional(),
      include: z.array(z.string()).default(["submission"]),
      order_by: z.enum(["position", "name", "due_at"]).optional(),
    }),
    async ({ course_id, ...query }, client) =>
      (await client.get(apiPath("courses", course_id, "assignments"), { ...query, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_get_assignment",
    "Get one assignment including its full HTML description and current submission data.",
    z.object({
      course_id: id,
      assignment_id: id,
      include: z.array(z.string()).default(["submission"]),
    }),
    async ({ course_id, assignment_id, include }, client) =>
      (await client.get(apiPath("courses", course_id, "assignments", assignment_id), { include })).data,
  );

  tool(
    server,
    "canvas_get_grades",
    "Get the current user's enrollment and course grade data.",
    z.object({ course_id: id, grading_period_id: id.optional() }),
    async ({ course_id, grading_period_id }, client) =>
      (await client.get(apiPath("courses", course_id, "enrollments"), {
        user_id: "self",
        type: ["StudentEnrollment"],
        include: ["current_points"],
        grading_period_id,
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_recently_graded",
    "List the current user's recently graded submissions.",
    z.object({
      only_current_enrollments: z.boolean().default(true),
      only_published_assignments: z.boolean().default(true),
    }),
    async (query, client) =>
      (await client.get("/api/v1/users/self/graded_submissions", {
        ...query,
        include: ["assignment"],
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_get_submission",
    "Get the current user's submission for one assignment.",
    z.object({
      course_id: id,
      assignment_id: id,
      include: z.array(z.string()).default(["submission_comments", "submission_history", "rubric_assessment"]),
    }),
    async ({ course_id, assignment_id, include }, client) =>
      (await client.get(apiPath("courses", course_id, "assignments", assignment_id, "submissions", "self"), { include })).data,
  );

  tool(
    server,
    "canvas_list_my_submissions",
    "List the current user's submissions in a course.",
    z.object({
      course_id: id,
      assignment_ids: z.array(id).optional(),
      include: z.array(z.string()).default(["assignment", "submission_comments", "rubric_assessment"]),
    }),
    async ({ course_id, assignment_ids, include }, client) =>
      (await client.get(apiPath("courses", course_id, "students", "submissions"), {
        student_ids: ["self"],
        assignment_ids,
        include,
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_submit_text",
    "Submit an assignment as an online text entry. Do not call this merely to draft, solve, write, complete, or review work. Call it only after the user explicitly asks to submit or turn in the assignment; the server then requests end user confirmation.",
    z.object({
      course_id: id,
      assignment_id: id,
      body: z.string(),
      comment: z.string().optional(),
    }),
    async ({ course_id, assignment_id, body, comment }, client) =>
      (await client.post(apiPath("courses", course_id, "assignments", assignment_id, "submissions"), {
        submission: { submission_type: "online_text_entry", body },
        ...(comment ? { comment: { text_comment: comment } } : {}),
      })).data,
  );

  tool(
    server,
    "canvas_submit_url",
    "Submit an assignment as an online URL. Only use after the user explicitly asks to submit or turn it in. The server requests end user confirmation before Canvas is changed.",
    z.object({
      course_id: id,
      assignment_id: id,
      url: z.string().url(),
      comment: z.string().optional(),
    }),
    async ({ course_id, assignment_id, url, comment }, client) =>
      (await client.post(apiPath("courses", course_id, "assignments", assignment_id, "submissions"), {
        submission: { submission_type: "online_url", url },
        ...(comment ? { comment: { text_comment: comment } } : {}),
      })).data,
  );

  tool(
    server,
    "canvas_submit_file",
    "Upload a local file using Canvas's official upload flow, then submit it as online_upload. Only use after the user explicitly asks to submit or turn it in. Confirmation happens before the upload begins.",
    z.object({
      course_id: id,
      assignment_id: id,
      file_path: z.string().min(1),
      comment: z.string().optional(),
    }),
    async ({ course_id, assignment_id, file_path, comment }, client) => {
      const uploaded = await client.uploadSubmissionFile(course_id, assignment_id, file_path);
      const fileId = uploaded.id;
      if (fileId === undefined || fileId === null) {
        throw new CanvasApiError("Canvas uploaded the file but did not return a file id.", undefined, uploaded);
      }
      const submission = await client.post(apiPath("courses", course_id, "assignments", assignment_id, "submissions"), {
        submission: { submission_type: "online_upload", file_ids: [fileId] },
        ...(comment ? { comment: { text_comment: comment } } : {}),
      });
      return { uploaded_file: uploaded, submission: submission.data };
    },
  );

  tool(
    server,
    "canvas_list_modules",
    "List modules in a course.",
    z.object({
      course_id: id,
      include: z.array(z.string()).default(["items", "content_details"]),
      search_term: z.string().optional(),
    }),
    async ({ course_id, include, search_term }, client) =>
      (await client.get(apiPath("courses", course_id, "modules"), {
        include,
        search_term,
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_list_module_items",
    "List items inside a Canvas module.",
    z.object({
      course_id: id,
      module_id: id,
      include: z.array(z.string()).default(["content_details"]),
      search_term: z.string().optional(),
    }),
    async ({ course_id, module_id, include, search_term }, client) =>
      (await client.get(apiPath("courses", course_id, "modules", module_id, "items"), {
        include,
        search_term,
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_mark_module_item",
    "Mark a module item read, done, or not done.",
    z.object({
      course_id: id,
      module_id: id,
      item_id: id,
      state: z.enum(["read", "done", "not_done"]),
    }),
    async ({ course_id, module_id, item_id, state }, client) => {
      const base = apiPath("courses", course_id, "modules", module_id, "items", item_id);
      if (state === "read") return (await client.post(base + "/mark_read")).data;
      if (state === "done") return (await client.put(base + "/done")).data;
      return (await client.delete(base + "/done")).data;
    },
  );

  tool(
    server,
    "canvas_list_pages",
    "List wiki pages in a course.",
    z.object({
      course_id: id,
      search_term: z.string().optional(),
      sort: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
    async ({ course_id, ...query }, client) =>
      (await client.get(apiPath("courses", course_id, "pages"), { ...query, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_get_page",
    "Get one course page including its HTML body.",
    z.object({ course_id: id, page_url_or_id: id }),
    async ({ course_id, page_url_or_id }, client) =>
      (await client.get(apiPath("courses", course_id, "pages", page_url_or_id))).data,
  );

  tool(
    server,
    "canvas_list_discussions",
    "List discussion topics in a course.",
    z.object({
      course_id: id,
      order_by: z.enum(["position", "recent_activity", "title"]).optional(),
      search_term: z.string().optional(),
      include: z.array(z.string()).optional(),
    }),
    async ({ course_id, ...query }, client) =>
      (await client.get(apiPath("courses", course_id, "discussion_topics"), { ...query, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_get_discussion",
    "Get a discussion topic. Full view includes entries and nested replies when Canvas permits it.",
    z.object({ course_id: id, topic_id: id, full_view: z.boolean().default(true) }),
    async ({ course_id, topic_id, full_view }, client) => {
      const base = apiPath("courses", course_id, "discussion_topics", topic_id);
      return (await client.get(full_view ? base + "/view" : base)).data;
    },
  );

  tool(
    server,
    "canvas_post_discussion_entry",
    "Post a top level discussion entry.",
    z.object({ course_id: id, topic_id: id, message: z.string().min(1) }),
    async ({ course_id, topic_id, message }, client) =>
      (await client.post(apiPath("courses", course_id, "discussion_topics", topic_id, "entries"), { message })).data,
  );

  tool(
    server,
    "canvas_reply_to_discussion",
    "Reply to a Canvas discussion entry.",
    z.object({ course_id: id, topic_id: id, entry_id: id, message: z.string().min(1) }),
    async ({ course_id, topic_id, entry_id, message }, client) =>
      (await client.post(apiPath("courses", course_id, "discussion_topics", topic_id, "entries", entry_id, "replies"), { message })).data,
  );

  tool(
    server,
    "canvas_list_files",
    "List files in a course.",
    z.object({
      course_id: id,
      search_term: z.string().optional(),
      content_types: z.array(z.string()).optional(),
      sort: z.enum(["name", "size", "created_at", "updated_at", "content_type", "user"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
    async ({ course_id, content_types, ...rest }, client) =>
      (await client.get(apiPath("courses", course_id, "files"), {
        ...rest,
        content_types,
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_get_file",
    "Get Canvas metadata for one file.",
    z.object({ file_id: id, include: z.array(z.string()).optional() }),
    async ({ file_id, include }, client) =>
      (await client.get(apiPath("files", file_id), { include })).data,
  );

  tool(
    server,
    "canvas_download_file",
    "Download a Canvas file to the local computer.",
    z.object({ file_id: id, destination_path: z.string().optional() }),
    async ({ file_id, destination_path }, client) =>
      client.downloadFile(file_id, destination_path),
  );

  tool(
    server,
    "canvas_activity_stream",
    "List the current user's global activity stream.",
    z.object({}),
    async (_args, client) =>
      (await client.get("/api/v1/users/self/activity_stream", { per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_list_quizzes",
    "List classic Canvas quizzes in a course. New Quizzes remain reachable through assignments and canvas_api.",
    z.object({ course_id: id, search_term: z.string().optional() }),
    async ({ course_id, search_term }, client) =>
      (await client.get(apiPath("courses", course_id, "quizzes"), { search_term, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_get_quiz",
    "Get one classic Canvas quiz.",
    z.object({ course_id: id, quiz_id: id }),
    async ({ course_id, quiz_id }, client) =>
      (await client.get(apiPath("courses", course_id, "quizzes", quiz_id))).data,
  );

  tool(
    server,
    "canvas_list_announcements",
    "List announcements for one or more courses.",
    z.object({
      course_ids: z.array(id).min(1),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      active_only: z.boolean().optional(),
    }),
    async ({ course_ids, ...query }, client) =>
      (await client.get("/api/v1/announcements", {
        context_codes: course_ids.map((courseId: string) => "course_" + courseId),
        ...query,
        per_page: 100,
      }, true)).data,
  );

  tool(
    server,
    "canvas_list_calendar_events",
    "List Canvas calendar and assignment events.",
    z.object({
      context_codes: z.array(z.string()).optional(),
      type: z.enum(["event", "assignment"]).optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      undated: z.boolean().optional(),
      all_events: z.boolean().optional(),
    }),
    async (query, client) =>
      (await client.get("/api/v1/calendar_events", { ...query, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_list_planner_items",
    "List planner items for the current user.",
    z.object({
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      context_codes: z.array(z.string()).optional(),
      filter: z.enum(["new_activity"]).optional(),
    }),
    async (query, client) =>
      (await client.get("/api/v1/planner/items", { ...query, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_list_conversations",
    "List Canvas Inbox conversations.",
    z.object({
      scope: z.string().optional(),
      filter: z.array(z.string()).optional(),
      filter_mode: z.enum(["and", "or", "default or"]).optional(),
      include_all_conversation_ids: z.boolean().optional(),
    }),
    async (query, client) =>
      (await client.get("/api/v1/conversations", { ...query, per_page: 100 }, true)).data,
  );

  tool(
    server,
    "canvas_get_conversation",
    "Get one Canvas Inbox conversation.",
    z.object({ conversation_id: id, auto_mark_as_read: z.boolean().optional() }),
    async ({ conversation_id, auto_mark_as_read }, client) =>
      (await client.get(apiPath("conversations", conversation_id), { auto_mark_as_read })).data,
  );

  tool(
    server,
    "canvas_send_message",
    "Create a Canvas Inbox conversation or send a message.",
    z.object({
      recipients: z.array(z.string()).min(1),
      body: z.string().min(1),
      subject: z.string().optional(),
      context_code: z.string().optional(),
      group_conversation: z.boolean().optional(),
    }),
    async (args, client) =>
      (await client.post("/api/v1/conversations", args)).data,
  );

  tool(
    server,
    "canvas_teacher_list_students",
    "List students in a course using stable pseudonymous student_ref values. Real names, emails, login IDs, SIS IDs, avatar URLs, and raw Canvas user IDs are not returned.",
    z.object({ course_id: id }),
    async ({ course_id }, client) => client.teacherStudents(course_id),
  );

  tool(
    server,
    "canvas_teacher_list_submissions",
    "List submissions for an assignment in teacher mode. Student identities are replaced with stable course scoped student_ref aliases before the data reaches the model.",
    z.object({
      course_id: id,
      assignment_id: id,
      include: z.array(z.string()).default(["submission_comments", "rubric_assessment"]),
    }),
    async ({ course_id, assignment_id, include }, client) => {
      client.requireTeacherMode();
      return (await client.get(
        apiPath("courses", course_id, "assignments", assignment_id, "submissions"),
        { include, per_page: 100 },
        true,
      )).data;
    },
  );

  tool(
    server,
    "canvas_teacher_get_submission",
    "Get one student's assignment submission using only its pseudonymous student_ref. The server resolves the alias to the real Canvas user locally and redacts the response.",
    z.object({
      course_id: id,
      assignment_id: id,
      student_ref: z.string().startsWith("student_"),
      include: z.array(z.string()).default(["submission_comments", "rubric_assessment", "submission_history"]),
    }),
    async ({ course_id, assignment_id, student_ref, include }, client) => {
      const userId = await client.resolveStudentRef(course_id, student_ref);
      return (await client.get(
        apiPath("courses", course_id, "assignments", assignment_id, "submissions", userId),
        { include },
      )).data;
    },
  );

  tool(
    server,
    "canvas_teacher_grade_submission",
    "Grade, excuse, set late state, or comment on a student's submission by student_ref. The real Canvas user ID is resolved only inside the server.",
    z.object({
      course_id: id,
      assignment_id: id,
      student_ref: z.string().startsWith("student_"),
      posted_grade: z.string().optional(),
      comment: z.string().optional(),
      excuse: z.boolean().optional(),
      late_policy_status: z.enum(["late", "missing", "extended", "none"]).nullable().optional(),
      seconds_late_override: z.number().int().min(0).optional(),
    }).refine(
      (value) =>
        value.posted_grade !== undefined ||
        value.comment !== undefined ||
        value.excuse !== undefined ||
        value.late_policy_status !== undefined ||
        value.seconds_late_override !== undefined,
      { message: "Provide at least one grading or comment change." },
    ),
    async ({
      course_id,
      assignment_id,
      student_ref,
      posted_grade,
      comment,
      excuse,
      late_policy_status,
      seconds_late_override,
    }, client) => {
      const userId = await client.resolveStudentRef(course_id, student_ref);
      const submission: Record<string, unknown> = {};
      if (posted_grade !== undefined) submission.posted_grade = posted_grade;
      if (excuse !== undefined) submission.excuse = excuse;
      if (late_policy_status !== undefined) submission.late_policy_status = late_policy_status;
      if (seconds_late_override !== undefined) submission.seconds_late_override = seconds_late_override;

      return (await client.put(
        apiPath("courses", course_id, "assignments", assignment_id, "submissions", userId),
        {
          ...(Object.keys(submission).length ? { submission } : {}),
          ...(comment !== undefined ? { comment: { text_comment: comment } } : {}),
        },
      )).data;
    },
  );

  tool(
    server,
    "canvas_teacher_message_student",
    "Send a Canvas Inbox message to a pseudonymous student_ref without exposing the student's real Canvas user ID to the model.",
    z.object({
      course_id: id,
      student_ref: z.string().startsWith("student_"),
      body: z.string().min(1),
      subject: z.string().optional(),
    }),
    async ({ course_id, student_ref, body, subject }, client) => {
      const userId = await client.resolveStudentRef(course_id, student_ref);
      const result = await client.post<Record<string, unknown>>("/api/v1/conversations", {
        recipients: [userId],
        body,
        subject,
        context_code: `course_${course_id}`,
      });
      return {
        sent: true,
        student_ref,
        conversation_id: result.data.id,
      };
    },
  );

  tool(
    server,
    "canvas_api",
    "Low level Canvas REST escape hatch. Supports any same origin /api/... route. GET is read only. Mutations obey CANVAS_WRITE_MODE and require explicit confirmation by default; never use this tool to bypass a dedicated tool confirmation.",
    z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      path: z.string().min(1),
      query: querySchema,
      body: z.record(z.string(), z.unknown()).optional(),
      body_encoding: z.enum(["form", "json"]).default("form"),
      paginate: z.boolean().default(false),
      max_pages: z.number().int().min(1).max(200).optional(),
    }),
    async ({ method, path, query, body, body_encoding, paginate, max_pages }, client) => {
      const result = await client.request(method as HttpMethod, path, {
        query: query as Query | undefined,
        body,
        bodyEncoding: body_encoding,
        paginate,
        maxPages: max_pages,
      });
      return {
        status: result.status,
        pages: result.pages,
        headers: result.headers,
        data: result.data,
      };
    },
  );

  return server;
}
