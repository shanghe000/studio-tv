import {expect,it,vi} from 'vitest';
import {LibraryNavigation,libraryBaseLocation,teamLibraryURL} from '../../apps/web/src/service/library-navigation';
import {isPersonalLibraryPath,personalLibraryPath,personalLibraryURL} from '../../apps/web/src/service/personal-library-navigation';

it('keeps the same team, folder and page under member-management steps and returns exactly one history entry',()=>{
 const navigate=vi.fn(),nav=new LibraryNavigation({pathname:'/projects/team-assets/team-a',search:'?folderId=f&page=2'},navigate);
 nav.open('members');expect(nav.base).toBe('/projects/team-assets/team-a?folderId=f&page=2');
 nav.open('add-member',{targetTeam:'team-a'});expect(nav.url.searchParams.get('panel')).toBe('add-member');
 nav.dismiss();expect(navigate).toHaveBeenLastCalledWith(-1);expect(nav.url.searchParams.get('panel')).toBe('members');
 nav.dismiss();expect(navigate).toHaveBeenLastCalledWith(-1);expect(nav.url.searchParams.has('panel')).toBe(false);expect(nav.url.searchParams.get('folderId')).toBe('f');
});
it('browser POP updates do not add history or submit actions and forward can restore the same panel',()=>{
 const navigate=vi.fn(),nav=new LibraryNavigation({pathname:'/projects/team-assets/t',search:'?folderId=child'},navigate),changed=vi.fn();nav.onChange=changed;
 nav.update({pathname:'/projects/team-assets/t',search:'?folderId=child&panel=new-folder'});nav.update({pathname:'/projects/team-assets/t',search:'?folderId=child'});nav.update({pathname:'/projects/team-assets/t',search:'?folderId=child&panel=new-folder'});
 expect(changed).toHaveBeenCalledTimes(3);expect(navigate).not.toHaveBeenCalled();expect(nav.url.searchParams.get('panel')).toBe('new-folder');
});
it('a refreshed member-removal confirmation returns past the obsolete editor to the members list',()=>{
 const navigate=vi.fn(),base='/projects/team-assets/t?folderId=f',trail=[base,base+'&panel=members',base+'&panel=edit-member&member=u'];
 const nav=new LibraryNavigation({pathname:'/projects/team-assets/t',search:'?folderId=f&panel=remove-member&member=u',state:{studioLibraryTrail:trail}},navigate);
 nav.dismiss('members');expect(navigate).toHaveBeenLastCalledWith(-2);expect(nav.url.searchParams.get('panel')).toBe('members');
 nav.dismiss();expect(navigate).toHaveBeenLastCalledWith(-1);expect(nav.base).toBe(base);
});
it.each([undefined,{studioLibraryTrail:['https://evil.invalid/']},{studioLibraryTrail:['/projects/team-assets/another']}])('cold or foreign panel state closes in place without leaving the requested team',state=>{
 const navigate=vi.fn(),nav=new LibraryNavigation({pathname:'/projects/team-assets/t',search:'?panel=publish&folderId=child',state},navigate);
 nav.dismiss();expect(navigate).toHaveBeenLastCalledWith('/projects/team-assets/t?folderId=child',{replace:true});
});
it('folder and page URLs have a single canonical form; dialog fields do not remount the background',()=>{
 expect(teamLibraryURL('team-a','folder-a',1)).toBe('/projects/team-assets/team-a?folderId=folder-a');
 expect(libraryBaseLocation({pathname:'/projects/team-assets/team-a',search:'?folderId=folder-a&panel=members&targetTeam=team-b'})).toBe('/projects/team-assets/team-a?folderId=folder-a');
 expect(personalLibraryURL(['parent','child'],true)).toBe('/projects/canvas/assetLibrary?libraryPath=parent%2Cchild&libraryDialog=create-folder');
 expect(personalLibraryPath('?libraryPath=parent%2Cchild')).toEqual(['parent','child']);expect(personalLibraryPath('?libraryPath=parent%2Cchild%2Cextra')).toEqual([]);expect(personalLibraryPath('?libraryPath=https://evil.invalid')).toEqual([]);
 expect(isPersonalLibraryPath('/projects/canvas/assetLibrary')).toBe(true);expect(isPersonalLibraryPath('/projects/canvas/assetLibrary/')).toBe(true);expect(isPersonalLibraryPath('/project/canvas/id')).toBe(false);
});
