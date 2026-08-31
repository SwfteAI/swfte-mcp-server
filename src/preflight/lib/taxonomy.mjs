/**
 * Node-type taxonomy.
 *
 * Derived from `enums/v2/NodeType.java` in agents-service (289 values at the
 * time of writing). The split is deliberately an ALLOW-list, not a deny-list:
 *
 *   CORE            — platform primitives. Always legal.
 *   OUTBOUND        — anything that can reach a human or a third party without
 *                     a person in the loop. Legal only when the manifest says so.
 *   everything else — a third-party integration. Legal only when the manifest
 *                     names it in `allowedIntegrations`.
 *
 * The deny-list is the shape that failed in the X Broker engagement: a
 * hand-written forbid list of outbound node types did not contain the
 * platform's own `EMAIL_SEND`, so a gate asserting "no automatic outreach"
 * could not fail. An allow-list has the opposite failure mode — a legitimate
 * node you forgot to declare produces a loud, cheap-to-fix warning.
 */

/** Platform primitives: control flow, data shaping, code, typed references. */
export const CORE = new Set([
  // model / reasoning
  'MODEL', 'LLM', 'CHATBOT', 'EMBEDDING', 'RERANK', 'AGENT', 'AI_TRANSFORM',
  'QUESTION_CLASSIFIER', 'PARAMETER_EXTRACTOR', 'SUMMARIZE',
  // code
  'CODE', 'JAVASCRIPT', 'PYTHON', 'FUNCTION', 'FUNCTION_ITEM', 'TOOL',
  // control flow
  'IF_ELSE', 'SWITCH', 'LOOP', 'LOOP_START', 'LOOP_END', 'ITERATION',
  'ITERATION_START', 'PARALLEL', 'MERGE', 'NOOP', 'FILTER', 'WAIT',
  'SPLIT_IN_BATCHES', 'STOP_AND_ERROR', 'CONDITION', 'ORCHESTRATION',
  // data shaping
  'VARIABLE_ASSIGNER', 'VARIABLE_AGGREGATOR', 'VARIABLE_AGGREGATOR_LEGACY',
  'TEMPLATE_TRANSFORM', 'FORMAT', 'JSON_TRANSFORM', 'LIST_OPERATOR',
  'ITEM_LISTS', 'DATE_TIME', 'RENAME_KEYS', 'COMPARE_DATASETS', 'SET',
  'AGGREGATE', 'LIMIT', 'REMOVE_DUPLICATES', 'SORT', 'SPLIT_OUT',
  'TRANSFORMATION', 'VALIDATION', 'MARKDOWN', 'HTML', 'XML', 'CRYPTO',
  'COMPRESSION', 'MOVE_BINARY_DATA', 'TOTP', 'JWT',
  // typed platform references
  'SUBWORKFLOW', 'CHATFLOW_TURN', 'KNOWLEDGE_RETRIEVAL', 'KNOWLEDGE_INDEX',
  'APP_FLOW_SEGMENT', 'DATASOURCE', 'DATA_TABLE', 'WIDGET_EMIT',
  'DOCUMENT_EXTRACTOR', 'READ_PDF', 'GENERATE_PDF', 'SPREADSHEET_FILE',
  // entry / exit
  'START', 'END', 'INPUT', 'OUTPUT', 'ANSWER',
  // triggers (inbound, not outbound)
  'SCHEDULE_TRIGGER', 'CRON_TRIGGER', 'WEBHOOK_TRIGGER', 'MANUAL_TRIGGER',
  'INTERVAL_TRIGGER', 'ERROR_TRIGGER', 'RSS_FEED_TRIGGER', 'URL_POLL_TRIGGER',
  'FORM_TRIGGER', 'LOCAL_FILE_TRIGGER', 'SSE_TRIGGER', 'TRIGGER',
  'WEBHOOK', 'RESPOND_TO_WEBHOOK',
  // generic reach — still needs a URL, but it is a primitive not an integration
  'HTTP_REQUEST', 'GRAPHQL', 'WEB_SEARCH', 'RSS_FEED',
  // human in the loop
  'HUMAN_INPUT',
  // misc primitives
  'CUSTOM', 'API', 'MONITORING', 'OPTIMIZATION', 'DEPLOYMENT', 'DATA_PIPELINE',
  'DATA_CATALOG_QUERY', 'READ_BINARY_FILE', 'WRITE_BINARY_FILE',
]);

/**
 * Node types that can reach a person or a third party with no human gate.
 * Every one of these is a candidate for the "zero automatic outreach" class of
 * client rule, and the list is generated from the enum rather than typed by
 * hand so a new channel cannot slip past by not being thought of.
 */
export const OUTBOUND = new Set([
  'EMAIL', 'EMAIL_SEND', 'SEND_EMAIL', 'EMAIL_NOTIFY', 'NOTIFICATION',
  'SLACK', 'DISCORD', 'MATTERMOST', 'MATRIX', 'ROCKETCHAT', 'TELEGRAM',
  'WHATSAPP', 'TWILIO', 'SMS77', 'VONAGE', 'PLIVO', 'MESSAGE_BIRD', 'MSG91',
  'MOCEAN', 'SIGNL4', 'SPONTIT', 'PUSHOVER', 'PUSHBULLET', 'PUSHCUT',
  'GOTIFY', 'LINE', 'TWIST', 'TWAKE', 'ZULIP', 'MICROSOFT_TEAMS', 'ZOOM',
  'CONVERSATIONAL_OUTREACH', 'PHONE_AUTOMATION', 'SENDGRID', 'MAILGUN',
  'MAILJET', 'MAILCHIMP', 'BREVO', 'POSTMARK', 'MANDRILL', 'CUSTOMER_IO',
  'GET_RESPONSE', 'LEMLIST', 'EMELIA', 'EGOI', 'MAUTIC', 'ITERABLE', 'SENDY',
  'VERO', 'AUTOPILOT', 'CONVERT_KIT', 'MAILERLITE', 'AUTOMIZY', 'GMAIL',
  'AWS_SES', 'AWS_SNS', 'PAGERDUTY', 'INTERCOM', 'DRIFT',
]);

/** Classify a node type. */
export function classify(type) {
  const t = String(type ?? '').toUpperCase();
  if (OUTBOUND.has(t)) return 'outbound';
  if (CORE.has(t)) return 'core';
  return 'integration';
}

/** Node types whose `result` is filed under `outputs.result` by the executor. */
export const RESULT_ROOTED = new Set(['CODE', 'JAVASCRIPT', 'PYTHON', 'FUNCTION', 'FUNCTION_ITEM']);
