import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = claims.sub;
  const email = claims.email;

  if (typeof userId !== 'string' || typeof email !== 'string') {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Authenticated token is missing required identity claims.' })
    };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: { id: userId, email },
      tenant: null
    })
  };
};
