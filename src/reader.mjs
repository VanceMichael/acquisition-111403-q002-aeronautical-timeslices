export async function collect(client) {
 const document=await client("/baseline");
 return [{id:document.facility, baseline:document.sliceId, properties:document.properties}];
}
