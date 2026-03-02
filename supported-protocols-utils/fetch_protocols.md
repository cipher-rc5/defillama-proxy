
# fetch-protocols

overview: bash shell script utility intended to assist with returning defillama protocol data

Curl request combined with `jq` for JSON processing and CSV output:

```bash
curl -s https://api.llama.fi/lite/protocols2 | \
  jq -r '.parentProtocols |
    sort_by(.id) |
    map({id: (.id | sub("^parent#"; ""))}) |
    ["id"] as $headers |
    $headers, (.[] | [.id]) |
    @csv' > supported_protocols.csv
```

This curl + jq pipeline does the same operations:
1. `curl -s` - Makes the GET request silently
2. `.parentProtocols` - Extracts the parentProtocols field
3. `sort_by(.id)` - Sorts by the id field
4. `map({id: (.id | sub("^parent#"; ""))})` - Removes the "parent#" prefix from each id
5. The CSV generation part creates headers and data rows
6. `> supported_protocols.csv` - Saves to file

If you prefer a more readable multi-line version:

```bash
curl -s https://api.llama.fi/lite/protocols2 | \
  jq -r '
    .parentProtocols |
    sort_by(.id) |
    map({id: (.id | sub("^parent#"; ""))}) |
    ["id"] as $headers |
    $headers, (.[] | [.id]) |
    @csv
  ' > supported_protocols.csv
```
