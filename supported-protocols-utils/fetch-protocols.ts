// filename: fetch-protocols.ts
// description: cloudflare-worker, effect compatible instance to fetch defillama protocols data and consume data externally

/**
 * Defines the structure of a single protocol from the LlamaFi API response.
 * We only define the properties we need for type safety.
 */
interface Protocol {
  parentProtocol?: string; // Optional: not all protocols are children
}

/**
 * Defines the structure of the top-level API response.
 */
interface ApiResponse {
  protocols: Protocol[];
}

// Cloudflare Workers use a default export with a `fetch` handler
// as the entry point for handling incoming requests.
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // 1. Fetch the data from the external API
      const response = await fetch('https://api.llama.fi/lite/protocols2');

      // Handle cases where the external API fails
      if (!response.ok) {
        throw new Error(`Failed to fetch from LlamaFi API: ${response.status} ${response.statusText}`);
      }

      // 2. Parse the JSON data
      const data: ApiResponse = await response.json();

      // 3. Process the data to get unique parent protocols
      // Use a Set to automatically handle uniqueness
      const parentProtocolIds = new Set<string>();

      for (const protocol of data.protocols) {
        if (protocol.parentProtocol) {
          parentProtocolIds.add(protocol.parentProtocol);
        }
      }

      // Convert the Set to an array, clean up the IDs, and sort alphabetically
      const processedProtocols = Array.from(parentProtocolIds).map(id => id.replace(/^parent#/, '')) // Remove the "parent#" prefix
        .sort((a, b) => a.localeCompare(b));

      // 4. Convert to CSV format
      const csv = [
        'id', // CSV header
        ...processedProtocols
      ].join('\n');

      // 5. Return the CSV data as the response
      // Instead of writing to a file, we return a Response object.
      // The headers tell the browser to treat this as a downloadable file.
      return new Response(csv, {
        status: 200,
        headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="supported_protocols.csv"' }
      });
    } catch (error) {
      // If any error occurs, return an error response
      console.error('cloudflare-worker error occurred:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      return new Response(errorMessage, { status: 500 });
    }
  }
};
