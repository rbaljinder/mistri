/** What DateField says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    enterADateAndTime: 'Enter a date and time as {format} within the allowed range.',
    enterADateInYyyy: 'Enter a date as {format} within the allowed range.',
    hhMm: 'HH:MM',
    dateAndTimeFormat: 'Date and time format: {format}.',
    dateFormatIs: 'Date format: {format}.',
    altAndDownArrow: 'Alt and Down arrow opens the calendar.',
    chooseDateFor: 'Choose date for {label}',
    chooseDate: 'Choose date',
    calendar: 'Calendar for {label}',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    timeFor: 'Time for {label}',
    time: 'Time',
  },
  {
    es: {
      enterADateAndTime: 'Ingresa una fecha y hora como {format} dentro del rango permitido.',
      enterADateInYyyy: 'Ingresa una fecha como {format} dentro del rango permitido.',
      hhMm: 'HH:MM',
      dateAndTimeFormat: 'Formato de fecha y hora: {format}.',
      dateFormatIs: 'Formato de fecha: {format}.',
      altAndDownArrow: 'Alt y flecha abajo abren el calendario.',
      chooseDateFor: 'Elegir fecha para {label}',
      chooseDate: 'Elegir fecha',
      calendar: 'Calendario para {label}',
      previousMonth: 'Mes anterior',
      nextMonth: 'Mes siguiente',
      timeFor: 'Hora para {label}',
      time: 'Hora',
    },
  },
);
