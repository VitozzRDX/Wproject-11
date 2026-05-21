import { Engine } from './engine.js'

const RULES = [

    {
        match: ({ unitId, button }) => 
        {
            console.log('checking if this is CLICK_UNIT command');
            if (!unitId) {
                console.log('not CLICK_UNIT: no unit');
                return false;
            }
            if (button === 2) {
                console.log('not CLICK_UNIT: right click');
                return false;
            }
            console.log('This is a CLICK_UNIT command');
            return true;
        },
        cmd: 'CLICK_UNIT'

    }
];

function createContext(e) {
    const unitId = e.target.getAttr('unitId'); // получаем id юнита из события
    const button = e.button; // получаем кнопку мыши из события
    return { unitId, button };
}

export function interpretEvent(e) {

    const ctx = createContext(e);



    const rule = RULES.find(r => r.match(ctx)); // ищем первое подходящее правило в массиве объектов типа { match: fn, cmd: 'COMMAND_NAME' }

    Engine.execute({ cmd: rule.cmd } ); // передаем команду в движок

}   

