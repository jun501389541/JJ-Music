/** Filter an existing ordered view without changing its stored order or identities. */
export function filterPlaylists<T extends {name:string}>(rows:readonly T[],query:string):T[]{
 const terms=query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
 return rows.filter(row=>{const name=row.name.normalize('NFKC').toLocaleLowerCase();return terms.every(term=>name.includes(term))})
}
