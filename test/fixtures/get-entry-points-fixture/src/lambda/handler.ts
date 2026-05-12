/**
 * AWS Lambda handler for the user events function.
 */

interface LambdaEvent {
  source: string;
  detail: Record<string, unknown>;
}

interface LambdaContext {
  functionName: string;
  awsRequestId: string;
}

/** Lambda entry point — handles incoming user events. */
export const handler = async (event: LambdaEvent, context: LambdaContext): Promise<void> => {
  console.log('Received event', event, context.awsRequestId);
};

/** Internal helper — formats the event for logging. */
function formatEvent(event: LambdaEvent): string {
  return JSON.stringify(event, null, 2);
}
