

const handlers = {
    CLICK_EMPTY: () => {
        console.log('CLICK_EMPTY');
    }
}

export const Engine = {

  // Получаем команду от Interpreter и выполняем нужный handler
  execute(command) {
    handlers[command.cmd]?.(command);
  }
}