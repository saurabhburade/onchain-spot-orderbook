type GraphqlError = {
  message?: string;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: GraphqlError[];
};

export async function requestIndexer<T>(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Indexer request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as GraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; "));
  }
  if (!payload.data) throw new Error("Indexer returned no GraphQL data");
  return payload.data;
}
