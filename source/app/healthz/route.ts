import {db} from '@/lib/server';
export const dynamic='force-dynamic';
export async function GET(){
  try {await db().prepare('SELECT id FROM people LIMIT 1').first();return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});}
}
